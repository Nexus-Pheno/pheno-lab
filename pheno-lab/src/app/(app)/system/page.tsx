import { notFound } from "next/navigation";
import { readdir, stat } from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { BackupButton } from "@/components/system/BackupButton";

const run = promisify(exec);

const fmtBytes = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
};

async function dirSize(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    let total = 0;
    for (const e of entries) {
      const s = await stat(path.join(dir, e)).catch(() => null);
      if (s?.isFile()) total += s.size;
      else if (s?.isDirectory()) total += await dirSize(path.join(dir, e));
    }
    return total;
  } catch {
    return 0;
  }
}

export default async function SystemPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  const t = await getT();

  // Where the database lives, from DATABASE_URL.
  const dbUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost:5432/pheno_lab");
  const dbHost = dbUrl.hostname || "localhost";
  const dbPort = dbUrl.port || "5432";
  const dbName = dbUrl.pathname.replace("/", "");
  const isLocal = dbHost === "localhost" || dbHost === "127.0.0.1";

  const [[sizeRow], tables] = await Promise.all([
    db.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`,
    db.$queryRaw<{ name: string; size: bigint }[]>`
      SELECT relname AS name, pg_total_relation_size(relid) AS size
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 8`,
  ]);

  const uploadsBytes = await dirSize(path.join(process.cwd(), "uploads"));

  // Disk usage of the volume the app (and a local database) lives on.
  let diskFree = "";
  let diskTotal = "";
  try {
    const { stdout } = await run(`df -k "${process.cwd()}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    diskTotal = fmtBytes(parseInt(parts[1]) * 1024);
    diskFree = fmtBytes(parseInt(parts[3]) * 1024);
  } catch { /* leave empty */ }

  // Backups on disk.
  const backupDir = path.join(process.cwd(), "backups");
  let backups: { name: string; size: string; date: string }[] = [];
  try {
    const files = (await readdir(backupDir)).filter((f) => f.endsWith(".sql.gz")).sort().reverse();
    backups = await Promise.all(
      files.slice(0, 10).map(async (f) => {
        const s = await stat(path.join(backupDir, f));
        return { name: f, size: fmtBytes(s.size), date: s.mtime.toISOString().replace("T", " ").slice(0, 16) };
      })
    );
  } catch { /* none yet */ }

  const tile = (label: string, value: string, sub?: string) => (
    <div className="bg-surface border border-line rounded-[6px] p-3.5">
      <div className="text-[10px] font-bold uppercase text-muted mb-1">{label}</div>
      <div className="mono text-[16px] font-bold">{value}</div>
      {sub && <div className="text-[10.5px] text-muted mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold">{t("sys.title")}</h1>
          <p className="text-xs text-muted">{t("sys.subtitle")}</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {tile(t("sys.dbLocation"), `${dbHost}:${dbPort}`, isLocal ? "PostgreSQL · local disk" : "PostgreSQL · remote")}
          {tile(t("sys.dbSize"), fmtBytes(Number(sizeRow.size)), t("sys.dbName") + ": " + dbName)}
          {tile(t("sys.uploads"), fmtBytes(uploadsBytes))}
          {tile(t("sys.disk"), diskFree, diskFree ? `${t("sys.diskFree")} ${diskTotal}` : "")}
        </div>

        <section className="bg-surface border border-line rounded-[6px] p-4">
          <h2 className="text-[13px] font-bold mb-2">{t("sys.tables")}</h2>
          <div className="space-y-1">
            {tables.map((tb) => {
              const max = Number(tables[0]?.size ?? 1);
              return (
                <div key={tb.name} className="flex items-center gap-3 text-[12px]">
                  <span className="mono w-48 truncate">{tb.name}</span>
                  <div className="flex-1 h-2 bg-subtle rounded-full overflow-hidden">
                    <div className="h-full bg-data-cyan/70 rounded-full" style={{ width: `${(Number(tb.size) / max) * 100}%` }} />
                  </div>
                  <span className="mono text-[11px] text-muted w-20 text-right">{fmtBytes(Number(tb.size))}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="bg-surface border border-line rounded-[6px] p-4">
          <div className="flex items-center gap-2 mb-1">
            <Icon name="DatabaseBackup" size={15} className="text-charcoal" />
            <h2 className="text-[13px] font-bold flex-1">{t("sys.backups")}</h2>
            <BackupButton />
          </div>
          <p className="text-[11px] text-muted mb-3">{t("sys.backupHint")}</p>
          {backups.length === 0 ? (
            <p className="text-[12px] text-muted">{t("sys.noBackups")}</p>
          ) : (
            <div className="space-y-1">
              {backups.map((b) => (
                <div key={b.name} className="flex items-center gap-3 text-[12px] border border-line rounded-[4px] px-3 py-1.5">
                  <Icon name="Archive" size={12} className="text-muted" />
                  <span className="mono flex-1 truncate">{b.name}</span>
                  <span className="mono text-[11px] text-muted">{b.size}</span>
                  <span className="mono text-[11px] text-muted">{b.date}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted mt-3 border-t border-line pt-2.5">
            <Icon name="Info" size={11} className="inline mr-1" />
            {t("sys.migrateHint")}
          </p>
        </section>
      </div>
    </main>
  );
}
