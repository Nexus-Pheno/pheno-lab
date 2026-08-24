import "server-only";

import { db as prisma } from "@/infrastructure/db/client";
import { hashApiKey } from "@/lib/instruments/credentials";

export { generateApiKey, hashApiKey } from "@/lib/instruments/credentials";

export type AuthedInstrument = {
  id: string;
  organizationId: string;
  name: string;
  kind: "GIANTFORCE_IV" | "LIGHTSKY_LIV";
};

export async function authenticateInstrumentToken(
  rawToken: string,
): Promise<AuthedInstrument | null> {
  const token = rawToken.trim();
  if (!token) return null;
  const instrument = await prisma.instrument.findUnique({
    where: { apiKeyHash: hashApiKey(token) },
    select: {
      id: true,
      organizationId: true,
      name: true,
      kind: true,
      active: true,
    },
  });
  if (!instrument || !instrument.active) return null;
  return instrument;
}
