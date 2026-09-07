import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { resolveSampleScan } from "@/modules/experiments/query";

// The landing for a scanned sample-label QR. The label encodes a stable URL
// (not an experiment/capture path) so reorganizing routes or samples never
// invalidates printed stock. Unauthenticated scans hit the login redirect in
// the proxy; scans of another team's experiment land on the request-access
// peek rather than a dead end.
export default async function ScanPage({
  params,
}: {
  params: Promise<{ sampleId: string }>;
}) {
  const { sampleId } = await params;
  const session = await requireSession();
  const hit = await resolveSampleScan(session, sampleId);
  if (!hit) notFound();
  if (!hit.canRead) redirect(`/experiments/${hit.experimentId}`);
  redirect(
    `/experiments/${hit.experimentId}/capture?from=portal&sample=${sampleId}`,
  );
}
