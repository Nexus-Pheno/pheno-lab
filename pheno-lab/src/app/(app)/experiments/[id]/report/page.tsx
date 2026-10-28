import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getExperimentCode } from "@/modules/experiments/query";

// Preserve authorized bookmarks after merging the single-experiment report
// into the live results comparison. Weekly /reports remains a separate feature.
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requireSession();
  const experiment = await getExperimentCode(actor, id);
  if (!experiment) notFound();
  redirect(`/experiments/${id}/results`);
}
