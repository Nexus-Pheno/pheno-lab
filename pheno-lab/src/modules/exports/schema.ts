import { z } from "zod";

export const exportRequestSchema = z.object({
  scope: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(500),
  rowCount: z.number().finite().nonnegative(),
  reason: z.string().trim().max(500),
});

export const exportDecisionSchema = z.object({
  id: z.string().min(1).max(128),
  approve: z.boolean(),
  note: z.string().trim().max(500),
});

export const exportSearchSchema = z.string().trim().max(500);
