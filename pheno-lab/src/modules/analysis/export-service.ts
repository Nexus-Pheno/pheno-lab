import "server-only";

import type { Actor } from "@/modules/authorization/actor";
import { METRICS } from "@/lib/analysis-metrics";
import { recordUserAudit } from "@/modules/audit/writer";
import { db } from "@/infrastructure/db/client";
import { loadAnalysisDataset } from "./query";

// The tidy table as a file: one row per sample, one column per condition and
// metric. This is the spreadsheet the technicians rebuild by hand before every
// review — the same numbers the page and the AI reading work from.
export async function buildTidyCsv(actor: Actor, rawScope: unknown) {
  const dataset = await loadAnalysisDataset(actor, rawScope);

  const conditionColumns = dataset.conditions.map((condition) => ({
    key: condition.key,
    header: `${condition.process ? `${condition.process} · ` : ""}${condition.label}${condition.unit ? ` (${condition.unit})` : ""}`,
  }));

  const columns = [
    "Experiment",
    "Title",
    "Project",
    "Date",
    "Sample ID",
    "Group",
    "Control",
    ...conditionColumns.map((c) => c.header),
    ...METRICS.map((metric) => metric.toUpperCase()),
  ];

  const escape = (value: string) => `"${(value ?? "").replaceAll('"', '""')}"`;
  const lines = [columns.map(escape).join(",")];
  for (const row of dataset.rows) {
    const cells = [
      row.experimentCode,
      row.experimentTitle,
      row.projectName ?? "",
      row.date,
      row.sampleCode,
      row.group ?? "",
      row.isControl ? "control" : "",
      ...conditionColumns.map((c) => row.conditions[c.key] ?? ""),
      ...METRICS.map((metric) => {
        const value = row.metrics[metric];
        return value === undefined ? "" : String(value);
      }),
    ];
    lines.push(cells.map(escape).join(","));
  }

  // Exports of research data are audited wherever they happen.
  await db.$transaction(async (tx) => {
    await recordUserAudit(tx, {
      actor,
      action: "analysis.exported",
      entityType: "Analysis",
      entityId: "tidy",
      metadata: { rows: dataset.rows.length, experiments: dataset.experiments },
    });
  });

  return {
    csv: lines.join("\n"),
    rows: dataset.rows.length,
    columns: columns.length,
  };
}
