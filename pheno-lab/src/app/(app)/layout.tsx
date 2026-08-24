import Image from "next/image";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { logout } from "@/lib/actions/auth";
import { db } from "@/lib/db";
import { getLang, getT } from "@/lib/i18n/server";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import { BackButton } from "@/components/BackButton";
import { ErrorCollector } from "@/components/ErrorCollector";

function ClipboardPenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v2M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <path d="M21.4 14.6a2 2 0 0 0-2.8-2.8L13 17.4V21h3.6z" />
    </svg>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const lang = await getLang();
  const t = await getT();
  const org = await db.organization.findUnique({ where: { id: session.org }, select: { name: true } });

  return (
    <LanguageProvider lang={lang}>
      <ErrorCollector />
      <div className="h-dvh flex flex-col">
        <header id="app-header" className="h-12 shrink-0 flex items-center gap-2 sm:gap-3 px-3 border-b border-line bg-surface print:hidden">
          <BackButton />
          <Link href="/" className="flex items-center">
            <Image src="/brand/pheno-logo.png" alt="Pheno" width={90} height={26} priority />
          </Link>
          <div className="w-px h-5 bg-line" />
          <nav className="hidden md:flex items-center gap-1 text-[13px] font-medium text-charcoal">
            <Link href="/" className="px-2 py-1 rounded-[4px] hover:bg-subtle">{t("nav.experiments")}</Link>
            <Link href="/library" className="px-2 py-1 rounded-[4px] hover:bg-subtle">{t("nav.library")}</Link>
            <Link href="/data" className="px-2 py-1 rounded-[4px] hover:bg-subtle">{t("nav.data")}</Link>
            <Link href="/portal" className="px-2 py-1 rounded-[4px] hover:bg-subtle text-brand-deep">{t("portal.toPortal")}</Link>
          </nav>
          <Link
            href="/portal"
            title={t("portal.toPortal")}
            className="md:hidden h-8 w-8 flex items-center justify-center border border-brand/50 text-brand-deep rounded-[4px]"
          >
            <ClipboardPenIcon />
          </Link>
          <div className="flex-1" />
          <span className="text-xs text-muted hidden sm:block">{org?.name ?? ""}</span>
          <Link
            href="/profile"
            title={t("nav.profile")}
            className="h-8 flex items-center gap-2 border border-line rounded-[4px] pl-1.5 pr-2.5 hover:bg-subtle"
          >
            <span className="w-6 h-6 rounded-full bg-brand-soft border border-brand/40 text-[9px] font-bold text-brand-deep flex items-center justify-center">
              {session.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="text-xs font-semibold text-charcoal whitespace-nowrap truncate max-w-24 sm:max-w-none">{session.name}</span>
          </Link>
          <form action={logout}>
            <button className="h-8 text-xs font-semibold text-charcoal border border-line rounded-[4px] px-3 hover:bg-subtle whitespace-nowrap shrink-0">
              {t("nav.signout")}
            </button>
          </form>
        </header>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </LanguageProvider>
  );
}
