import { z } from "zod";

export const chemicalIdSchema = z.string().trim().min(1).max(200);
export const smilesSchema = z.string().trim().min(1).max(4000);
export const chemicalRowSchema = z.object({
  id: chemicalIdSchema.nullable(),
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  expectedDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  smiles: smilesSchema,
});
export const chemicalListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  q: z.string().trim().max(200).default(""),
});
export const chemicalCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  nameZh: z.string().trim().max(100).default(""),
});
