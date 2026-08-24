import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { OrgManage, type OrgUserRow } from "@/components/org/OrgManage";
import { Icon } from "@/components/ui";

// Each organization's admin manages their own org here: settings, the
// people in it, their roles, and who is responsible for materials,
// equipment and facilities.
export default async function OrganizationPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  const t = await getT();

  const [org, users, pending] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: session.org } }),
    db.user.findMany({
      where: { organizationId: session.org },
      orderBy: [{ role: "asc" }, { userNumber: "asc" }],
      select: {
        id: true, name: true, email: true, role: true, active: true, createdAt: true,
        materialAdmin: true, equipmentAdmin: true, facilityAdmin: true, recipeAccess: true,
      },
    }),
    db.otpCode.findMany({
      where: { organizationId: session.org, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const rows: OrgUserRow[] = users.map((u) => ({
    ...u,
    createdAt: u.createdAt.toISOString().slice(0, 10),
  }));

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <h1 className="text-lg font-bold">{t("org.title")}</h1>
            <p className="text-xs text-muted">{t("org.subtitle")}</p>
          </div>
          {org.orgNumber === 1 && (
            <Link
              href="/organizations"
              className="h-8 flex items-center gap-1.5 px-3 border border-line rounded-[4px] text-[12px] font-semibold text-charcoal hover:bg-subtle"
            >
              <Icon name="Network" size={13} /> {t("orgs.title")}
            </Link>
          )}
        </div>

        <OrgManage
          sessionUid={session.uid}
          orgName={org.name}
          orgNumber={org.orgNumber}
          users={rows}
          domains={org.emailDomains.join(", ")}
          pending={pending.map((p) => ({
            email: p.email,
            code: p.code,
            expiresAt: p.expiresAt.toISOString().replace("T", " ").slice(0, 16),
          }))}
        />
      </div>
    </main>
  );
}
