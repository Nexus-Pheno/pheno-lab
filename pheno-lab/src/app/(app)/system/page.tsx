import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { BackupButton } from "@/components/system/BackupButton";
import { getSystemStatus } from "@/modules/system/query";

const fmtBytes = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
};

export default async function SystemPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  const t = await getT();
  const status = await getSystemStatus(session);
  const diskFree =
    status.storage.diskFreeBytes === null
      ? ""
      : fmtBytes(status.storage.diskFreeBytes);
  const diskTotal =
    status.storage.diskTotalBytes === null
      ? ""
      : fmtBytes(status.storage.diskTotalBytes);

  const tile = (label: string, value: string, sub?: string) => (
    <div className="bg-surface border border-line rounded-[6px] p-3.5">
      <div className="text-[10px] font-bold uppercase text-muted mb-1">
        {label}
      </div>
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
          {tile(
            t("sys.dbLocation"),
            `${status.database.host}:${status.database.port}`,
            status.database.local
              ? "PostgreSQL · local disk"
              : "PostgreSQL · remote",
          )}
          {tile(
            t("sys.dbSize"),
            fmtBytes(status.database.sizeBytes),
            t("sys.dbName") + ": " + status.database.name,
          )}
          {tile(t("sys.uploads"), fmtBytes(status.storage.uploadsBytes))}
          {tile(
            t("sys.disk"),
            diskFree,
            diskFree ? `${t("sys.diskFree")} ${diskTotal}` : "",
          )}
        </div>

        <section className="bg-surface border border-line rounded-[6px] p-4">
          <h2 className="text-[13px] font-bold mb-2">{t("sys.tables")}</h2>
          <div className="space-y-1">
            {status.database.tables.map((tb) => {
              const max = status.database.tables[0]?.sizeBytes ?? 1;
              return (
                <div
                  key={tb.name}
                  className="flex items-center gap-3 text-[12px]"
                >
                  <span className="mono w-48 truncate">{tb.name}</span>
                  <div className="flex-1 h-2 bg-subtle rounded-full overflow-hidden">
                    <div
                      className="h-full bg-data-cyan/70 rounded-full"
                      style={{ width: `${(tb.sizeBytes / max) * 100}%` }}
                    />
                  </div>
                  <span className="mono text-[11px] text-muted w-20 text-right">
                    {fmtBytes(tb.sizeBytes)}
                  </span>
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
          {status.backups.length === 0 ? (
            <p className="text-[12px] text-muted">{t("sys.noBackups")}</p>
          ) : (
            <div className="space-y-1">
              {status.backups.map((b) => (
                <div
                  key={b.name}
                  className="flex items-center gap-3 text-[12px] border border-line rounded-[4px] px-3 py-1.5"
                >
                  <Icon name="Archive" size={12} className="text-muted" />
                  <span className="mono flex-1 truncate">{b.name}</span>
                  <span className="mono text-[11px] text-muted">
                    {fmtBytes(b.sizeBytes)}
                  </span>
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
