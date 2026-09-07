"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MaterialCard } from "@/lib/materials-meta";
import { reviewMaterialEdit } from "@/lib/actions/materials";
import { useT } from "@/lib/i18n/LanguageProvider";

type ReviewRow = {
  id: string;
  material: string;
  author: string;
  status: string;
  base: MaterialCard;
  changes: MaterialCard;
};

export function MaterialReviews({
  rows,
  canManage,
}: {
  rows: ReviewRow[];
  canManage: boolean;
}) {
  const translate = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!rows.length) return null;
  return (
    <section className="bg-surface border border-line rounded-md p-4 space-y-3">
      <h2 className="font-bold text-sm">{translate("review.materials")}</h2>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {rows.map((row) => (
        <details key={row.id} className="border-t border-line pt-2">
          <summary className="cursor-pointer text-sm">
            {row.material} · {row.author} ·{" "}
            {translate(
              row.status === "PENDING"
                ? "review.pending"
                : row.status === "APPROVED"
                  ? "review.approved"
                  : "review.rejected",
            )}
          </summary>
          <dl className="text-xs my-3 space-y-2 break-words">
            {Object.entries(row.changes)
              .filter(
                ([key, value]) =>
                  JSON.stringify(value) !==
                  JSON.stringify(row.base[key as keyof MaterialCard]),
              )
              .map(([key, value]) => (
                <div key={key}>
                  <dt className="font-semibold">{key}</dt>
                  <dd className="whitespace-pre-wrap">
                    {JSON.stringify(row.base[key as keyof MaterialCard])} →{" "}
                    {JSON.stringify(value)}
                  </dd>
                </div>
              ))}
          </dl>
          {canManage && row.status === "PENDING" && (
            <div className="flex gap-4">
              {(["APPROVED", "REJECTED"] as const).map((decision) => (
                <button
                  key={decision}
                  disabled={busy}
                  className="text-sm text-brand-deep font-semibold disabled:opacity-50"
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await reviewMaterialEdit(row.id, decision);
                      router.refresh();
                    } catch {
                      setError(translate("review.failed"));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {translate(
                    decision === "APPROVED"
                      ? "review.approve"
                      : "review.reject",
                  )}
                </button>
              ))}
            </div>
          )}
        </details>
      ))}
    </section>
  );
}
