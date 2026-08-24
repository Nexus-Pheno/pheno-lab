import { z } from "zod";

export const MAX_INSTRUMENT_FILE_SIZE = 25 * 1024 * 1024;

const optionalDate = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((value, context) => {
    if (!value) return null;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      context.addIssue({
        code: "custom",
        message: "modifiedAt must be an ISO-compatible timestamp",
      });
      return z.NEVER;
    }
    return new Date(timestamp);
  });

export const instrumentUploadMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(300),
  sourcePath: z.string().max(500).default(""),
  sourceDir: z.string().max(500).default(""),
  modifiedAt: optionalDate,
  mime: z.string().trim().max(200).default(""),
});

export const heartbeatSchema = z.object({
  hostname: z.string().max(200).default(""),
  agentVersion: z.string().max(40).default(""),
  lastError: z.string().max(500).default(""),
  watchDirs: z.array(z.string().max(400)).max(100).default([]),
});

export const instrumentEntityIdSchema = z.string().min(1).max(128);

export const measurementAssignmentSchema = z.object({
  measurementId: instrumentEntityIdSchema,
  sampleId: instrumentEntityIdSchema,
});

export const measurementUnassignmentSchema = z.object({
  measurementId: instrumentEntityIdSchema,
  ignore: z.boolean(),
});

export const sampleAliasesSchema = z.object({
  sampleId: instrumentEntityIdSchema,
  aliases: z.array(z.string().trim().min(1).max(200)).max(100),
});

export const serialExplanationSchema = z.string().trim().min(1).max(500);
