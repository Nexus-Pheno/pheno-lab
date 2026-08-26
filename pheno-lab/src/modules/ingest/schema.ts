import { z } from "zod";

import { storedDocumentSchema } from "@/modules/files/schema";

export const ingestKindSchema = z.enum([
  "EQUIPMENT",
  "MATERIAL",
  "EXPERIMENT",
  "FORMULA",
  "ENVIRONMENT",
  "PRESET",
]);

export const ingestIdSchema = z.string().min(1).max(128);
export const ingestIdsSchema = z
  .array(ingestIdSchema)
  .min(1)
  .max(1_000)
  .transform((ids) => [...new Set(ids)]);
export const ingestReviewNoteSchema = z.string().max(20_000);
export const ingestPayloadSchema = z.record(z.string(), z.unknown());

const text = (maximum = 20_000) => z.string().max(maximum).default("");
const requiredName = z.string().trim().min(1).max(500);
const parameterDefinitionSchema = z.object({
  name: requiredName,
  unit: text(100),
  defaultValue: text(4_000),
});

export const materialDraftSchema = z.object({
  name: requiredName,
  category: z.string().trim().min(1).max(120).default("OTHER"),
  composition: text(4_000),
  smiles: text(4_000),
  casNumber: text(500),
  molecularWeight: text(500),
  purity: text(500),
  supplier: text(500),
  lot: text(500),
  properties: z.record(z.string().max(200), z.string().max(20_000)).default({}),
  notes: text(50_000),
});

export const equipmentDraftSchema = z.object({
  name: requiredName,
  make: text(500),
  model: text(500),
  assetTag: text(500),
  processName: requiredName,
  locationName: text(500),
  parameters: z.array(parameterDefinitionSchema).max(500).default([]),
  documents: z.array(storedDocumentSchema).max(50).default([]),
  notes: text(50_000),
});

export const formulaDraftSchema = z.object({
  name: requiredName,
  summary: text(2_000),
  composition: text(4_000),
  bandGap: text(500),
  components: z
    .array(
      z.object({
        material: requiredName,
        amount: text(500),
        role: text(500).optional(),
      }),
    )
    .min(1)
    .max(500),
  solvents: text(4_000),
  concentration: text(1_000),
  procedure: text(50_000),
  notes: text(50_000).optional(),
});

export const environmentDraftSchema = z.object({
  name: requiredName,
  conditions: z.array(parameterDefinitionSchema).max(500).default([]),
  documents: z.array(storedDocumentSchema).max(50).default([]),
  notes: text(50_000),
});

export const presetDraftSchema = z.object({
  name: requiredName,
  processName: requiredName,
  parameters: z
    .array(
      z.object({
        name: requiredName,
        unit: text(100),
        value: text(4_000),
      }),
    )
    .max(500)
    .default([]),
  notes: text(50_000),
});

export const experimentDraftSchema = z.object({
  title: requiredName,
  operator: requiredName,
  scale: z.enum(["LARGE", "SMALL", "OTHER"]),
  batchLabel: text(500),
  date: z.string().max(20).default(""),
  campaign: text(500),
  hypothesis: text(50_000),
  problem: text(50_000),
  conclusion: text(50_000),
  observation: text(50_000),
  steps: z
    .array(
      z.object({
        processName: requiredName,
        name: text(500),
        parameters: z
          .array(
            z.object({
              name: requiredName,
              unit: text(100),
              value: text(4_000),
            }),
          )
          .max(1_000),
        materialNames: z.array(requiredName).max(1_000),
        recipeName: text(500),
      }),
    )
    .max(1_000),
  characterizations: z
    .array(z.object({ processName: requiredName, name: text(500) }))
    .max(1_000),
  samples: z
    .array(
      z.object({
        code: z.string().trim().max(100),
        metrics: z.record(
          z.string().max(200),
          z.union([z.string(), z.number()]),
        ),
        files: z.array(z.string().max(4_000)).max(10_000),
        note: text(20_000),
      }),
    )
    .max(10_000),
  sourceFiles: z.array(z.string().max(4_000)).max(10_000),
});

export const stageIngestSchema = z.object({
  kind: ingestKindSchema,
  title: requiredName,
  sourceFile: z.string().max(4_000).optional(),
  confidence: z.string().max(2_000).optional(),
  payload: ingestPayloadSchema,
});

export const publishResolutionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("AUTO") }),
  z.object({ mode: z.literal("UPDATE"), targetId: ingestIdSchema }),
  z.object({ mode: z.literal("CREATE_ANYWAY") }),
]);

export const duplicateActionSchema = z.enum(["REPLACE", "SKIP", "DELETE"]);

export function parseIngestDraft(
  kind: z.infer<typeof ingestKindSchema>,
  raw: unknown,
) {
  if (kind === "MATERIAL") return materialDraftSchema.parse(raw);
  if (kind === "EQUIPMENT") return equipmentDraftSchema.parse(raw);
  if (kind === "FORMULA") return formulaDraftSchema.parse(raw);
  if (kind === "ENVIRONMENT") return environmentDraftSchema.parse(raw);
  if (kind === "PRESET") return presetDraftSchema.parse(raw);
  return experimentDraftSchema.parse(raw);
}
