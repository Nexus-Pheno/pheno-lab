import { z } from "zod";

export const workflowIdSchema = z.string().min(1).max(128);
export const workflowNoteSchema = z.string().trim().max(20_000);
export const assignmentSchema = z.object({
  experimentId: workflowIdSchema,
  userId: workflowIdSchema.nullable(),
});
