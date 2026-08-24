import crypto from "node:crypto";

/** Agent keys are bearer tokens; only the SHA-256 is persisted. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

export function generateApiKey(): string {
  return "phb_" + crypto.randomBytes(24).toString("base64url");
}
