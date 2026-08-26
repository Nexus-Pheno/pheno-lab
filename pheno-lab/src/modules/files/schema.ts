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

// Equipment spec sheets are usually vendor PDFs, occasionally an Office file.
// Datasheets with large diagrams run bigger than a photo, hence the wider cap.
export const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024;
export const DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
] as const;

export const DOCUMENT_EXTENSIONS: Record<
  (typeof DOCUMENT_TYPES)[number],
  string
> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
};

export const documentUploadSchema = z
  .instanceof(File)
  .refine(
    (file) =>
      DOCUMENT_TYPES.includes(file.type as (typeof DOCUMENT_TYPES)[number]),
    { message: "Only PDF, Word, Excel or text documents are allowed" },
  )
  .refine((file) => file.size <= MAX_DOCUMENT_SIZE, {
    message: "Max 50 MB",
  });

/** A stored document as referenced by a business record. */
export const storedDocumentSchema = z.object({
  fileName: z.string().trim().min(1).max(500),
  storedPath: z.string().trim().min(1).max(4_000),
  mime: z.string().trim().max(200).default(""),
  size: z.number().int().min(0).max(MAX_DOCUMENT_SIZE).default(0),
});
