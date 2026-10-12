import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { canOpenChemicals, listChemicals } from "@/modules/chemicals/query";
import { ChemicalsWorkbench } from "@/components/chemicals/ChemicalsWorkbench";

export default async function ChemicalsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const actor = await requireSession();
  if (!(await canOpenChemicals(actor))) notFound();
  const params = await searchParams;
  const page = /^\d+$/.test(params.page ?? "")
    ? Math.max(1, Math.min(10000, Number(params.page)))
    : 1;
  const result = await listChemicals(actor, {
    page,
    q: (params.q ?? "").slice(0, 200),
  });
  return (
    <ChemicalsWorkbench
      key={`${page}:${params.q ?? ""}`}
      data={result}
      query={params.q ?? ""}
    />
  );
}
