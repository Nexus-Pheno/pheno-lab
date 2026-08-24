import type { Prisma } from "@prisma/client";

const FORBIDDEN_KEY =
  /password|passphrase|secret|token|api.?key|otp|cookie|authorization/i;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 100;

export function sanitizeAuditValue(
  value: unknown,
): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeAuditValue(item) ?? null);
  }
  if (typeof value === "object") {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      const sanitized = sanitizeAuditValue(item);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}
