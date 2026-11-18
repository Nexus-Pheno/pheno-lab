import { notFound } from "next/navigation";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { getLang } from "@/lib/i18n/server";
import { readerSettings } from "@/modules/research-reader/access";
import { ReaderKeys } from "./reader-keys";
export default async function AgentAccess() {
  const actor = await requireSession();
  if (actor.role !== "ADMIN") notFound();
  assertPersonalDevice(actor);
  const settings = await readerSettings(actor);
  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <ReaderKeys settings={settings} zh={(await getLang()) === "zh"} />
    </main>
  );
}
