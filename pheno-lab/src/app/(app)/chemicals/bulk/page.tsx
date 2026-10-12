import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  canOpenChemicals,
  listChemicalCategories,
} from "@/modules/chemicals/query";
import { ChemicalsBulkUpload } from "@/components/chemicals/ChemicalsBulkUpload";

export default async function ChemicalBulkPage() {
  const actor = await requireSession();
  if (!(await canOpenChemicals(actor))) notFound();
  return (
    <ChemicalsBulkUpload
      initialCategories={await listChemicalCategories(actor)}
    />
  );
}
