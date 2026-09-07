import { getLang } from "@/lib/i18n/server";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";

export default async function ResetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LanguageProvider lang={await getLang()}>{children}</LanguageProvider>;
}
