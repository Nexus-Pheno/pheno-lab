import { z } from "zod";

export const entityIdSchema = z.string().trim().min(1).max(128);

const stringMapSchema = z
  .record(z.string().trim().min(1).max(200), z.string().max(2_000))
  .refine((value) => Object.keys(value).length <= 200, "Too many fields");

export const objectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9._/-]+$/)
  .refine((value) => !value.includes(".."), "Invalid object key");

export const executionDataSchema = z.object({
  actuals: stringMapSchema,
  materialSelections: z
    .record(
      z.string().trim().min(1).max(200),
      z.string().trim().min(1).max(128),
    )
    .refine((value) => Object.keys(value).length <= 200, "Too many fields")
    .default({}),
  environmentConditions: stringMapSchema,
  note: z.string().max(10_000),
  flagged: z.boolean(),
  photoFileNames: z.array(objectKeySchema).max(20).optional(),
});

export const executionBatchSchema = z.object({
  runId: entityIdSchema,
  stepId: entityIdSchema,
  sampleIds: z
    .array(entityIdSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate sample IDs"),
  data: executionDataSchema,
});

export const captureTargetSchema = executionBatchSchema.pick({
  runId: true,
  stepId: true,
  sampleIds: true,
});

export const executionPhotosSchema = captureTargetSchema.extend({
  fileNames: z.array(objectKeySchema).min(1).max(20),
});

export const characterizationResultSchema = z.object({
  characterizationId: entityIdSchema,
  sampleId: entityIdSchema,
  runId: entityIdSchema.optional(),
  metrics: stringMapSchema,
  note: z.string().max(10_000),
});
