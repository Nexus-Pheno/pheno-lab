import { z } from "zod";

export const experimentIdSchema = z.string().min(1).max(128);
const optionalIdSchema = experimentIdSchema.nullable();
const jsonTextMapSchema = z.record(z.string().max(200), z.string().max(20_000));

export const experimentMetaSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    campaign: z.string().trim().max(500).optional(),
    observation: z.string().max(50_000).optional(),
    problem: z.string().max(50_000).optional(),
    hypothesis: z.string().max(50_000).optional(),
    conclusion: z.string().max(50_000).optional(),
    status: z
      .enum(["DRAFT", "IN_LAB", "REVIEW", "COMPLETE", "ARCHIVED"])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.");

export const sampleSetSchema = z
  .array(
    z.object({
      code: z.string().trim().min(1).max(100),
      variationGroup: z.string().trim().max(100).nullable(),
    }),
  )
  .min(1)
  .max(10_000)
  .refine(
    (rows) =>
      new Set(rows.map((row) => row.code.toUpperCase())).size === rows.length,
    "Sample codes must be unique.",
  );

export const stepDraftSchema = z.object({
  name: z.string().trim().min(1).max(500),
  equipmentId: optionalIdSchema,
  environmentId: optionalIdSchema,
  environmentConditions: jsonTextMapSchema,
  recipeId: optionalIdSchema,
  layer: z.string().trim().max(200),
  notes: z.string().max(50_000),
  materials: z
    .array(
      z.object({
        materialId: experimentIdSchema,
        amount: z.string().max(500),
      }),
    )
    .max(500),
  parameters: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        unit: z.string().max(100),
        value: z.string().max(4_000),
        source: z.string().max(100),
        variations: z
          .array(
            z.object({
              variationGroup: z.string().trim().min(1).max(100),
              value: z.string().max(4_000),
            }),
          )
          .max(500),
      }),
    )
    .max(500),
});

export const characterizationDraftSchema = z.object({
  name: z.string().trim().min(1).max(500),
  equipmentId: optionalIdSchema,
  environmentId: optionalIdSchema,
  environmentConditions: jsonTextMapSchema,
  settings: jsonTextMapSchema,
  sampleScope: z.string().trim().max(200),
  notes: z.string().max(50_000),
});

const presetMaterialSchema = z.object({
  materialId: experimentIdSchema,
  amount: z.string().max(500),
});

export const stepPresetPayloadSchema = z.object({
  equipmentId: optionalIdSchema,
  environmentId: optionalIdSchema,
  environmentConditions: jsonTextMapSchema,
  materials: z.array(presetMaterialSchema).max(500),
  parameters: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        unit: z.string().max(100),
        value: z.string().max(4_000),
        source: z.string().max(100).optional(),
      }),
    )
    .max(500),
});

export const charPresetPayloadSchema = z.object({
  equipmentId: optionalIdSchema,
  environmentId: optionalIdSchema,
  environmentConditions: jsonTextMapSchema,
  settings: jsonTextMapSchema,
  sampleScope: z.string().trim().max(200),
});

export const presetUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    payload: z
      .union([stepPresetPayloadSchema, charPresetPayloadSchema])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.");

export const presetNameSchema = z.string().trim().min(1).max(500);

export const testPlanSchema = z.object({
  groups: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        samples: z.number().int().min(1).max(10_000),
        isControl: z.boolean(),
      }),
    )
    .min(1)
    .max(100),
  variables: z
    .array(
      z.object({
        kind: z.enum(["parameter", "material"]),
        processId: experimentIdSchema,
        equipmentId: experimentIdSchema.optional(),
        layer: z.string().max(200).optional(),
        parameter: z.string().trim().min(1).max(200),
        unit: z.string().max(100),
        values: z.record(z.string().max(100), z.string().max(4_000)),
      }),
    )
    .max(500),
});

export const orderedIdsSchema = z
  .array(experimentIdSchema)
  .max(1_000)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate ids supplied.");
