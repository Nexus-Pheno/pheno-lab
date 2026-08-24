import { db } from "@/lib/db";
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
  "Experiment", "Title", "Status", "Sample ID", "Group", "Control", "Created by",
  "Observation", "Problem", "Hypothesis", "Conclusion", "Labels",
] as const;

const experimentInclude = {
  createdBy: { select: { name: true } },
  samples: { orderBy: { code: "asc" } },
  steps: {
    orderBy: { position: "asc" },
    include: {
      process: true,
      equipment: true,
      environment: true,
      materials: { orderBy: { position: "asc" }, include: { material: true } },
      parameters: { orderBy: { position: "asc" }, include: { variations: true } },
    },
  },
  characterizations: {
    orderBy: { position: "asc" },
    include: { process: true, equipment: true, environment: true, results: true },
  },
  labels: { include: { label: true } },
  runs: { include: { executions: true } },
} satisfies Prisma.ExperimentInclude;

type FullExperiment = Prisma.ExperimentGetPayload<{ include: typeof experimentInclude }>;

export type DataPage = {
  columns: string[];
  rows: Record<string, string>[];
  total: number; // total samples matching the query
  page: number;
  pageSize: number;
};

/** Search matches an experiment's code/title/campaign or a sample's code. */
function whereFor(base: Prisma.ExperimentWhereInput, q: string): Prisma.ExperimentWhereInput {
  const term = q.trim();
  if (!term) return base;
  return {
    AND: [
      base,
      {
        OR: [
          { code: { contains: term, mode: "insensitive" } },
          { title: { contains: term, mode: "insensitive" } },
          { campaign: { contains: term, mode: "insensitive" } },
          { samples: { some: { code: { contains: term, mode: "insensitive" } } } },
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
    const execByKey = new Map<string, (typeof exp.runs)[number]["executions"][number]>();
    for (const run of exp.runs) {
      for (const x of run.executions) execByKey.set(`${x.stepId}|${x.sampleId}`, x);
    }

    for (const sample of exp.samples) {
      const row: Record<string, string> = {
        Experiment: exp.code,
        Title: exp.title,
        Status: exp.status,
        "Sample ID": `${exp.code}-${sample.code}`,
        Group: sample.variationGroup ?? "",
        Control: sample.variationGroup && controlGroup ? String(sample.variationGroup === controlGroup) : "",
        "Created by": exp.createdBy.name,
        Observation: exp.observation,
        Problem: exp.problem,
        Hypothesis: exp.hypothesis,
        Conclusion: exp.conclusion,
        Labels: exp.labels.map((l) => l.label.name).join("; "),
      };

      for (const step of exp.steps) {
        const prefix = `${String(step.position + 1).padStart(2, "0")} ${step.name}`;
        row[col(`${prefix} · Process`)] = step.process.name;
        if (step.equipment) row[col(`${prefix} · Equipment`)] = step.equipment.name;
        if (step.materials.length > 0) {
          row[col(`${prefix} · Materials`)] = step.materials
            .map((m) => (m.amount ? `${m.material.name} (${m.amount})` : m.material.name))
            .join("; ");
        }
        if (step.environment) {
          const conds = Object.entries((step.environmentConditions ?? {}) as Record<string, string>)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
          row[col(`${prefix} · Environment`)] = conds ? `${step.environment.name} (${conds})` : step.environment.name;
        }
        const execution = execByKey.get(`${step.id}|${sample.id}`);
        const actuals = (execution?.actuals ?? {}) as Record<string, string>;
        for (const p of step.parameters) {
          const name = col(`${prefix} · ${p.name}${p.unit ? ` (${p.unit})` : ""}${p.source === "material" ? " [material]" : ""}`);
          const variation = sample.variationGroup
            ? p.variations.find((v) => v.variationGroup === sample.variationGroup)
            : undefined;
          row[name] = variation?.value ?? p.value;
          if (execution && actuals[p.name] !== undefined) {
            row[col(`${prefix} · ${p.name} [actual]`)] = actuals[p.name];
          }
        }
        if (execution?.flagged) row[col(`${prefix} · Flagged`)] = "true";
        if (execution?.note) row[col(`${prefix} · Capture note`)] = execution.note;
      }

      for (const c of exp.characterizations) {
        const prefix = `Char ${c.name}`;
        if (c.equipment) row[col(`${prefix} · Instrument`)] = c.equipment.name;
        for (const [k, v] of Object.entries((c.settings ?? {}) as Record<string, string>)) {
          row[col(`${prefix} · ${k}`)] = v;
        }
        const result = c.results.find((r) => r.sampleId === sample.id);
        for (const [k, v] of Object.entries((result?.metrics ?? {}) as Record<string, string>)) {
          if (v !== "") row[col(`${prefix} · ${k} [result]`)] = String(v);
        }
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
  { page = 1, perPage = 25, q = "" }: { page?: number; perPage?: number; q?: string }
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
  maxExperiments = 300
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
