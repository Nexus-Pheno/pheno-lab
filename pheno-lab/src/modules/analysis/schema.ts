import { z } from "zod";
import { METRICS } from "@/modules/experiments/summary-service";

/** Which slice of the lab's history an analysis runs over. */
export const analysisScopeSchema = z.object({
  /** Beijing calendar dates, inclusive. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  projectId: z.string().max(128).optional(),
  /** Free text over experiment code/title, materials and processes. */
  q: z.string().trim().max(120).optional(),
  metric: z.enum(METRICS).default("pce"),
  /** Condition key to break the comparison down by. */
  condition: z.string().max(400).optional(),
});

export type AnalysisScope = z.infer<typeof analysisScopeSchema>;

export const analysisQuestionSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  scope: analysisScopeSchema,
  lang: z.enum(["en", "zh"]),
});
