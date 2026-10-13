import { z } from "zod";

export const reportIdSchema = z.string().min(1).max(128);
export const reportListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

export const grantReportAccessSchema = z
  .object({
    organizationId: reportIdSchema,
    senderUserId: reportIdSchema,
    recipientUserId: reportIdSchema,
    requestId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,119}$/),
    authorizationReference: z.string().trim().min(5).max(500),
  })
  .refine(
    (input) => input.senderUserId !== input.recipientUserId,
    "The approving administrator and recipient must be different accounts.",
  );
export const publishReportSchema = z.object({
  organizationId: reportIdSchema,
  publicationKey: z.string().regex(/^[a-z0-9][a-z0-9-]{2,119}$/),
  titleEn: z.string().trim().min(1).max(200),
  titleZh: z.string().trim().min(1).max(200),
  generatedAt: z.coerce.date(),
  html: z
    .string()
    .min(50)
    .max(2_000_000)
    .refine(
      (value) => /^\s*<!doctype html>/i.test(value) && /<html\b/i.test(value),
      "A complete HTML document is required.",
    ),
  recipientIds: z.array(reportIdSchema).min(1).max(20),
  requireExistingAccess: z.boolean().default(false),
  authorizationReference: z.string().trim().min(1).max(500),
});
