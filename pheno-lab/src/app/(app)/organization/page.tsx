import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { OrgManage, type OrgUserRow } from "@/components/org/OrgManage";
import { Icon } from "@/components/ui";
import { getOrganizationManagementData } from "@/modules/organizations/query";
import { hasStewardship } from "@/modules/stewardship/service";
import { listRegistrationApprovals } from "@/modules/accounts/registration-service";
import { listProjects } from "@/modules/experiments/project-service";
import { fmtBeijing } from "@/lib/datetime";

// Each organization's admin manages their own org here: settings, the
// people in it, their roles, and who is responsible for materials,
// equipment and facilities.
export default async function OrganizationPage() {
  const session = await requireSession();
  assertPersonalDevice(session);
  if (!(await hasStewardship(session, "memberAdmin"))) notFound();
  const canAdmin = session.role === "ADMIN";
  const t = await getT();

  const [
    { organization: org, users, pending },
    { approvals, legacyOptions },
    projects,
  ] = await Promise.all([
    getOrganizationManagementData(session),
    listRegistrationApprovals(session),
    canAdmin
      ? listProjects(session, { includeInactive: true })
      : Promise.resolve([]),
  ]);

  const rows: OrgUserRow[] = users.map((u) => ({
    ...u,
    createdAt: fmtBeijing(u.createdAt, "date"),
  }));

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <h1 className="text-lg font-bold">
              {t(canAdmin ? "org.title" : "org.members")}
            </h1>
            <p className="text-xs text-muted">
              {t(canAdmin ? "org.subtitle" : "org.membersHint")}
            </p>
          </div>
          {canAdmin && org.orgNumber === 1 && (
            <Link
              href="/organizations"
              className="h-8 flex items-center gap-1.5 px-3 border border-line rounded-[4px] text-[12px] font-semibold text-charcoal hover:bg-subtle"
            >
              <Icon name="Network" size={13} /> {t("orgs.title")}
            </Link>
          )}
        </div>

        <OrgManage
          canAdmin={canAdmin}
          approvals={approvals}
          legacyOptions={legacyOptions}
          sessionUid={session.uid}
          orgName={org.name}
          orgNumber={org.orgNumber}
          users={rows}
          projects={projects.map((p) => ({
            id: p.id,
            name: p.name,
            active: p.active,
          }))}
          domains={org.emailDomains.join(", ")}
          pending={pending.map((p) => ({
            email: p.email,
            code: p.code,
            purpose: p.purpose,
            expiresAt: fmtBeijing(p.expiresAt),
          }))}
        />
      </div>
    </main>
  );
}
