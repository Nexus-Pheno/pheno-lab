import { requireSession } from "@/lib/auth";
import { getOwnAccountData } from "@/modules/accounts/query";
import { ProfileForms } from "@/components/profile/ProfileForms";
import { fmtBeijing } from "@/lib/datetime";

export default async function AccountPage() {
  const session = await requireSession("account");
  const user = await getOwnAccountData(session);
  return (
    <main className="h-full overflow-y-auto bg-subtle p-4 sm:p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-xl font-bold mb-4">{user.name}</h1>
        <ProfileForms
          user={{
            name: user.name,
            handle: user.handle,
            email: user.email,
            language: user.language === "zh" ? "zh" : "en",
            role: user.role,
            createdAt: fmtBeijing(user.createdAt, "date"),
          }}
          orgName={user.organization.name}
        />
      </div>
    </main>
  );
}
