import { z } from "zod";

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const imageUploadSchema = z
  .instanceof(File)
  .refine(
    (file) => IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number]),
    {
      message: "Only images are allowed",
    },
  )
  .refine((file) => file.size <= MAX_IMAGE_SIZE, {
    message: "Max 10 MB",
  });
