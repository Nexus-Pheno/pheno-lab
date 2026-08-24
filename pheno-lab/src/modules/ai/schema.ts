import { z } from "zod";

export const aiProviderIdSchema = z.string().min(1).max(128);

const baseUrlSchema = z
  .url()
  .max(2_000)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Only HTTP(S) provider URLs are supported.",
  })
  .transform((value) => value.replace(/\/+$/, ""));

export const aiProviderSaveSchema = z.object({
  id: aiProviderIdSchema.optional(),
  label: z.string().trim().max(200),
  provider: z.string().trim().min(1).max(100),
  baseUrl: baseUrlSchema,
  model: z.string().trim().min(1).max(300),
  apiKey: z.string().trim().max(8_000),
});

export const aiModelListSchema = z.object({
  id: aiProviderIdSchema.optional(),
  baseUrl: z.union([baseUrlSchema, z.literal(""), z.undefined()]),
  apiKey: z.string().trim().max(8_000).optional(),
});
