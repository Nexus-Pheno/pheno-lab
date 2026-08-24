import { requireSession } from "@/lib/auth";
import { getLang } from "@/lib/i18n/server";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import { ErrorCollector } from "@/components/ErrorCollector";

// The input portal has its own minimal chrome — no desktop navigation.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return (
    <LanguageProvider lang={await getLang()}>
      <ErrorCollector />
      <div className="h-dvh">{children}</div>
    </LanguageProvider>
  );
}
