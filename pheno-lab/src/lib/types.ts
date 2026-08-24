import type { Prisma } from "@prisma/client";
import type { ParamDef } from "@/lib/library";

export const experimentInclude = {
  createdBy: { select: { id: true, name: true } },
  members: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
  samples: { orderBy: { code: "asc" } },
  steps: {
    orderBy: { position: "asc" },
    include: {
      process: true,
      equipment: true,
      environment: true,
      materials: { orderBy: { position: "asc" }, include: { material: true } },
      parameters: { orderBy: { position: "asc" }, include: { variations: true } },
      recipe: { select: { id: true, name: true, summary: true } },
    },
  },
  characterizations: {
    orderBy: { position: "asc" },
    include: { process: true, equipment: true, environment: true },
  },
  labels: { include: { label: true } },
} satisfies Prisma.ExperimentInclude;

export type ExperimentFull = Prisma.ExperimentGetPayload<{ include: typeof experimentInclude }>;
export type StepFull = ExperimentFull["steps"][number];
export type ParamFull = StepFull["parameters"][number];
export type CharFull = ExperimentFull["characterizations"][number];
export type SampleRow = ExperimentFull["samples"][number];
export type MemberRow = ExperimentFull["members"][number];

export type ParamInput = {
  name: string;
  unit: string;
  value: string;
  source: string; // "process" | "equipment" | "material" | "custom"
  variations: { variationGroup: string; value: string }[];
};

export type MaterialInput = { materialId: string; amount: string };

// Full step payload written by "Save changes" in the inspector.
export type StepDraft = {
  name: string;
  equipmentId: string | null;
  environmentId: string | null;
  environmentConditions: Record<string, string>;
  recipeId: string | null;
  layer: string;
  notes: string;
  materials: MaterialInput[];
  parameters: ParamInput[];
};

export type CharDraft = {
  name: string;
  equipmentId: string | null;
  environmentId: string | null;
  environmentConditions: Record<string, string>;
  settings: Record<string, string>;
  sampleScope: string;
  notes: string;
};

export type StepPresetPayload = {
  equipmentId: string | null;
  environmentId: string | null;
  environmentConditions: Record<string, string>;
  materials: MaterialInput[];
  parameters: { name: string; unit: string; value: string; source?: string }[];
};

export type CharPresetPayload = {
  equipmentId: string | null;
  environmentId: string | null;
  environmentConditions: Record<string, string>;
  settings: Record<string, string>;
  sampleScope: string;
};

export const paramDefs = (json: Prisma.JsonValue | null | undefined): ParamDef[] =>
  Array.isArray(json) ? (json as ParamDef[]) : [];
