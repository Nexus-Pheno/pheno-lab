import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { canOpenChemicals } from "@/modules/chemicals/query";
import { ChemicalsBulkUpload } from "@/components/chemicals/ChemicalsBulkUpload";

export default async function ChemicalBulkPage() {
  const actor = await requireSession();
  if (!(await canOpenChemicals(actor))) notFound();
  return <ChemicalsBulkUpload />;
}
