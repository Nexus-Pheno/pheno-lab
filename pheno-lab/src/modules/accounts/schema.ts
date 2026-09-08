import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8).max(128);
export const roleSchema = z.enum(["ADMIN", "MANAGER", "TECHNICIAN"]);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const registrationSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().max(200),
  password: passwordSchema,
});

export const passwordResetSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  password: passwordSchema,
});

export const createUserSchema = z.object({
  name: z.string().trim().max(200),
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema,
});

export const feedbackSchema = z.object({
  kind: z.enum(["bug", "feedback"]),
  title: z.string().trim().max(300).default(""),
  message: z.string().trim().min(1).max(20_000),
  screenshotPath: z.string().max(512).default(""),
  // Multi-screenshot uploads (one problem, several shots).
  photoFileNames: z.array(z.string().max(512)).max(10).default([]),
  errorLog: z.string().max(8_000).default(""),
  pageUrl: z.string().max(500).default(""),
  userAgent: z.string().max(300).default(""),
});

// The admin's triage decision: status and/or comments, plus optional edits
// that tighten the reporter's wording before an agent implements it.
export const feedbackReviewSchema = z
  .object({
    id: z.string().min(1).max(128),
    status: z.enum(["open", "approved", "rejected", "implemented"]).optional(),
    adminNote: z.string().max(20_000).optional(),
    implementationNote: z.string().trim().max(20_000).optional(),
    title: z.string().trim().max(300).optional(),
    message: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, "No changes supplied.")
  .refine(
    (v) => v.status !== "implemented" || (v.implementationNote ?? "") !== "",
    "Marking implemented requires patch notes for the reporter.",
  );

// The reporter's verdict on an implemented item: a green light, or a
// reopen that must say why.
export const feedbackVerifySchema = z
  .object({
    id: z.string().min(1).max(128),
    accept: z.boolean(),
    note: z.string().trim().max(20_000).default(""),
  })
  .refine((v) => v.accept || v.note !== "", "Reopening requires a reason.");

// Admin normalizes a teammate's identity (English names, the szpheno domain).
export const userIdentitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: emailSchema,
});

// The admin's approval of a self-registration, with corrections applied and
// an optional legacy dataset claimed in the same stroke.
export const registrationApprovalSchema = z.object({
  userId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  handle: z.string().trim().max(100).default(""),
  email: emailSchema,
  legacyUserId: z.string().max(128).default(""),
});

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  handle: z.string().trim().max(100),
});

export const passwordChangeSchema = z.object({
  current: z.string().min(1).max(128),
  next: passwordSchema,
});

export const languageSchema = z.enum(["en", "zh"]);

export const organizationSubmissionSchema = z.object({
  token: z.string().min(20).max(500),
  orgName: z.string().trim().min(1).max(200),
  domainsCsv: z.string().max(5_000),
  adminName: z.string().trim().max(200),
  adminEmail: emailSchema,
  password: passwordSchema,
});

export const organizationNameSchema = z.string().trim().min(1).max(200);
export const inviteTokenSchema = z.string().min(20).max(500);

// Shared lab tablets (kiosk mode).
export const deviceLabelSchema = z.string().trim().min(1).max(120);
export const deviceIdSchema = z.string().min(1).max(128);
export const setupTokenSchema = z.string().min(20).max(200);

// NFC badges. Web NFC reports serial numbers as colon-separated hex
// ("04:1d:c6:8a:da:1b:90"); we store canonical lowercase hex, no separators.
// NTAG UIDs are 7 bytes, but 4/8/10-byte tags exist — accept 4–10 bytes.
export const badgeUidSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/[:\s-]/g, ""))
  .pipe(z.string().regex(/^[0-9a-f]{8,20}$/));
export const badgeTokenSchema = z.string().max(200).default("");
