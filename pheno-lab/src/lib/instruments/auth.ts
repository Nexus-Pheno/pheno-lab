import crypto from "crypto";
import { db as prisma } from "@/lib/db";
import type { NextRequest } from "next/server";

/** Agent keys are bearer tokens; only the SHA-256 is ever stored. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

export function generateApiKey(): string {
  return "phb_" + crypto.randomBytes(24).toString("base64url");
}

export type AuthedInstrument = {
  id: string;
  organizationId: string;
  name: string;
  kind: "GIANTFORCE_IV" | "LIGHTSKY_LIV";
};

export async function authenticateInstrument(req: NextRequest): Promise<AuthedInstrument | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const instrument = await prisma.instrument.findUnique({
    where: { apiKeyHash: hashApiKey(token) },
    select: { id: true, organizationId: true, name: true, kind: true, active: true },
  });
  if (!instrument || !instrument.active) return null;
  return instrument;
}
