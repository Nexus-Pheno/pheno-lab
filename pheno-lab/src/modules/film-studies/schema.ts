import { z } from "zod";
import { methods } from "./methods";
export const PART_BYTES = 2 * 1024 * 1024;
export const fileSpec = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => Boolean(name.trim()))
    .refine(
      (s) => !/[\\/\u0000-\u001f\u007f]/u.test(s) && s !== "." && s !== "..",
    ),
  size: z.number().int().positive().max(2147483647),
});
export const manifest = z
  .object({
    id: z.uuid(),
    measuredOn: z.iso.date().optional(),
    method: z.string().refine((s) => methods.some((m) => m.code === s)),
    customMethod: z.string().trim().max(160).default(""),
    notes: z.string().trim().max(12000),
    materialIds: z.array(z.string().min(1).max(128)).max(100),
    files: z.array(fileSpec).min(1).max(100),
  })
  .strict()
  .refine((v) =>
    v.method === "OTHER" ? Boolean(v.customMethod) : !v.customMethod,
  )
  .refine((v) => Boolean(v.notes) || v.materialIds.length > 0);
export function partCount(size: number) {
  return Math.ceil(size / PART_BYTES);
}
export function partSize(size: number, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= partCount(size))
    return 0;
  return Math.min(PART_BYTES, size - index * PART_BYTES);
}
export class StudyError extends Error {
  constructor(public code: "invalid" | "conflict" | "missing" | "incomplete") {
    super(code);
  }
}
