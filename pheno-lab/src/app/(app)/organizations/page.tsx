import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { OrgAdmin } from "@/components/orgs/OrgAdmin";

// Platform-operator view: every trusted organization, pending submissions,
// and invite-link generation. Only admins of organization #1 see this.
export default async function OrganizationsPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  const own = await db.organization.findUnique({ where: { id: session.org } });
  if (!own || own.orgNumber !== 1) notFound();
  const t = await getT();

  const orgs = await db.organization.findMany({
    orderBy: { orgNumber: "asc" },
    include: {
      users: {
        orderBy: { userNumber: "asc" },
        select: { name: true, email: true, role: true, active: true },
      },
    },
  });

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-6">
        <div>
          <h1 className="text-lg font-bold">{t("orgs.title")}</h1>
          <p className="text-xs text-muted">{t("orgs.subtitle")}</p>
        </div>
        <OrgAdmin
          orgs={orgs.map((o) => {
            const admin = o.users.find((u) => u.role === "ADMIN");
            return {
              id: o.id,
              orgNumber: o.orgNumber,
              name: o.name,
              domains: o.emailDomains.join(", "),
              status: o.status,
              userCount: o.users.length,
              adminName: admin?.name ?? "—",
              adminEmail: admin?.email ?? "",
            };
          })}
        />
      </div>
    </main>
  );
}
