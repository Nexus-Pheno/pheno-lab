import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Prisma } from "@prisma/client";
import type { TestPlan } from "@/lib/library";

// One row per sample with every parameter resolved for that sample's
// variation group — tagged and AI-ready. Columns are namespaced:
// "01 Step name · Parameter (unit)".
//
// This is deliberately built a PAGE AT A TIME. The lab now holds ~18k samples
// across ~940 experiments; materialising every row (and the union of every
// experiment's columns) locks up both the server payload and the browser.

export const FIXED_COLUMNS = [
  "Experiment",
  "Title",
  "Status",
  "Sample ID",
  "Group",
  "Control",
  "Created by",
  "Observation",
  "Problem",
  "Hypothesis",
  "Conclusion",
  "Labels",
] as const;

const experimentInclude = {
  createdBy: { select: { name: true } },
  samples: {
    orderBy: { code: "asc" },
    include: {
      // Every kept scan, so exports show each individual test run.
      jvMeasurements: {
        where: { status: "MATCHED" },
        orderBy: { measuredAt: "asc" },
        select: { metrics: true, direction: true },
      },
    },
  },
  steps: {
    orderBy: { position: "asc" },
    include: {
      process: true,
      equipment: true,
      environment: true,
      materials: { orderBy: { position: "asc" }, include: { material: true } },
      parameters: {
        orderBy: { position: "asc" },
        include: { variations: true },
      },
    },
  },
  characterizations: {
    orderBy: { position: "asc" },
    include: {
      process: true,
      equipment: true,
      environment: true,
      results: {
        where: {
          OR: [
            { runId: null },
            { run: { is: { status: { not: "CANCELLED" } } } },
          ],
        },
      },
    },
  },
  labels: { include: { label: true } },
  runs: {
    where: { status: { not: "CANCELLED" } },
    include: { executions: true },
  },
} satisfies Prisma.ExperimentInclude;

type FullExperiment = Prisma.ExperimentGetPayload<{
  include: typeof experimentInclude;
}>;

export type DataPage = {
  columns: string[];
  rows: Record<string, string>[];
  total: number; // total samples matching the query
  page: number;
  pageSize: number;
};

/**
 * Search matches anything a person would name: the experiment's code, title,
 * campaign and notes; who created, is assigned to, or is a member of it; the
 * processes, materials, step text and parameter values inside it; sample
 * codes; and the operator on its instrument scans. "Joey" finding nothing
 * because only four fields were searched is the 2026-09-16 feedback §一.
 */
function whereFor(
  base: Prisma.ExperimentWhereInput,
  q: string,
): Prisma.ExperimentWhereInput {
  const term = q.trim();
  if (!term) return base;
  const c = { contains: term, mode: "insensitive" as const };
  return {
    AND: [
      base,
      {
        OR: [
          { code: c },
          { title: c },
          { campaign: c },
          { hypothesis: c },
          { problem: c },
          { conclusion: c },
          { observation: c },
          { createdBy: { name: c } },
          { assignee: { name: c } },
          { members: { some: { user: { name: c } } } },
          { samples: { some: { code: c } } },
          { jvMeasurements: { some: { operator: c } } },
          {
            steps: {
              some: {
                OR: [
                  { name: c },
                  { process: { name: c } },
                  { materials: { some: { material: { name: c } } } },
                  { parameters: { some: { OR: [{ name: c }, { value: c }] } } },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}

function buildRows(experiments: FullExperiment[]): DataPage {
  const columns: string[] = [];
  const seen = new Set<string>();
  const col = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      columns.push(name);
    }
    return name;
  };
  FIXED_COLUMNS.forEach(col);

  const rows: Record<string, string>[] = [];

  for (const exp of experiments) {
    const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
    const controlGroup = plan?.groups.find((g) => g.isControl)?.label ?? null;

    // Executions indexed once per experiment instead of scanned per sample —
    // the old nested find turned into millions of comparisons at this size.
    const execByKey = new Map<
      string,
      (typeof exp.runs)[number]["executions"][number]
    >();
    for (const run of exp.runs) {
      for (const x of run.executions)
        execByKey.set(`${x.stepId}|${x.sampleId}`, x);
    }

    for (const sample of exp.samples) {
      const row: Record<string, string> = {
        Experiment: exp.code,
        Title: exp.title,
        Status: exp.status,
        "Sample ID": `${exp.code}-${sample.code}`,
        Group: sample.variationGroup ?? "",
        Control:
          sample.variationGroup && controlGroup
            ? String(sample.variationGroup === controlGroup)
            : "",
        "Created by": exp.createdBy.name,
        Observation: exp.observation,
        Problem: exp.problem,
        Hypothesis: exp.hypothesis,
        Conclusion: exp.conclusion,
        Labels: exp.labels.map((l) => l.label.name).join("; "),
      };

      for (const step of exp.steps) {
        // The column family is named after the PROCESS, not the step's free
        // text: imported steps carry the whole condition string as their name
        // ("SAM deposition — CELL4 0.8浓度，纯甲醇体系，20倍旋涂1500RPM-30S"), which
        // made every header unreadable (实验系统反馈 2026-09-16 §二). The text
        // is still here, in its own column.
        const prefix = `${String(step.position + 1).padStart(2, "0")} ${step.process.name}`;
        row[col(`${prefix} · Step`)] = step.name;
        if (step.equipment)
          row[col(`${prefix} · Equipment`)] = step.equipment.name;
        if (step.materials.length > 0) {
          row[col(`${prefix} · Materials`)] = step.materials
            .map((m) =>
              m.amount ? `${m.material.name} (${m.amount})` : m.material.name,
            )
            .join("; ");
        }
        if (step.environment) {
          const conds = Object.entries(
            (step.environmentConditions ?? {}) as Record<string, string>,
          )
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
          row[col(`${prefix} · Environment`)] = conds
            ? `${step.environment.name} (${conds})`
            : step.environment.name;
        }
        const execution = execByKey.get(`${step.id}|${sample.id}`);
        const actuals = (execution?.actuals ?? {}) as Record<string, string>;
        for (const p of step.parameters) {
          const name = col(
            `${prefix} · ${p.name}${p.unit ? ` (${p.unit})` : ""}${p.source === "material" ? " [material]" : ""}`,
          );
          const variation = sample.variationGroup
            ? p.variations.find(
                (v) => v.variationGroup === sample.variationGroup,
              )
            : undefined;
          row[name] = variation?.value ?? p.value;
          if (execution && actuals[p.name] !== undefined) {
            row[col(`${prefix} · ${p.name} [actual]`)] = actuals[p.name];
          }
        }
        if (execution?.flagged) row[col(`${prefix} · Flagged`)] = "true";
        if (execution?.note)
          row[col(`${prefix} · Capture note`)] = execution.note;
      }

      for (const c of exp.characterizations) {
        const prefix = `Char ${c.name}`;
        if (c.equipment) row[col(`${prefix} · Instrument`)] = c.equipment.name;
        for (const [k, v] of Object.entries(
          (c.settings ?? {}) as Record<string, string>,
        )) {
          row[col(`${prefix} · ${k}`)] = v;
        }
        const result = c.results.find((r) => r.sampleId === sample.id);
        for (const [k, v] of Object.entries(
          (result?.metrics ?? {}) as Record<string, string>,
        )) {
          if (v !== "") row[col(`${prefix} · ${k} [result]`)] = String(v);
        }
      }

      if (sample.jvMeasurements.length > 0) {
        row[col("J-V scans (all runs)")] = sample.jvMeasurements
          .map((m, index) => {
            const metrics = (m.metrics ?? {}) as Record<string, unknown>;
            const fmt = (v: unknown) =>
              typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "-";
            const dir = m.direction ? ` ${m.direction[0]}` : "";
            return `#${index + 1}${dir}: PCE ${fmt(metrics.pce)}% Voc ${fmt(metrics.voc)} Jsc ${fmt(metrics.jsc)} FF ${fmt(metrics.ff)}`;
          })
          .join(" | ");
      }

      rows.push(row);
    }
  }

  return { columns, rows, total: rows.length, page: 1, pageSize: rows.length };
}

/**
 * One page of the data table. Paging is by EXPERIMENT (a sample only makes
 * sense next to its own experiment's columns), so a page holds every sample
 * of the experiments it covers.
 */
export async function loadDataPage(
  base: Prisma.ExperimentWhereInput,
  {
    page = 1,
    perPage = 25,
    q = "",
  }: { page?: number; perPage?: number; q?: string },
): Promise<DataPage> {
  const where = whereFor(base, q);
  const total = await db.experiment.count({ where });
  const experiments = await db.experiment.findMany({
    where,
    orderBy: { code: "asc" },
    skip: (page - 1) * perPage,
    take: perPage,
    include: experimentInclude,
  });
  const built = buildRows(experiments);
  return { ...built, total, page, pageSize: perPage };
}

/** Full export for the current search — capped so one click can't melt the box. */
export async function loadDataForExport(
  base: Prisma.ExperimentWhereInput,
  q: string,
  maxExperiments = 300,
): Promise<DataPage> {
  const where = whereFor(base, q);
  const experiments = await db.experiment.findMany({
    where,
    orderBy: { code: "asc" },
    take: maxExperiments,
    include: experimentInclude,
  });
  return buildRows(experiments);
}
