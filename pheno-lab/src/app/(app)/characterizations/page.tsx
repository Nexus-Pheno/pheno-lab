import { requireSession } from "@/lib/auth";
import { notFound } from "next/navigation";
import { canOpenStudies } from "@/modules/film-studies/access";
import { portalData } from "@/modules/film-studies/query";
import { StudiesPortal } from "@/components/film-studies/StudiesPortal";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await requireSession();
  if (!(await canOpenStudies(actor))) notFound();
  const raw = (await searchParams).page ?? "1";
  const page = /^\d{1,6}$/.test(raw) ? Math.max(1, Number(raw)) : 1;
  const data = await portalData(actor, page);
  return <StudiesPortal {...data} page={page} />;
}
