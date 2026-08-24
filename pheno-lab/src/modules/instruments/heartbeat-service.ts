import "server-only";

import { db } from "@/infrastructure/db/client";
import type { AuthedInstrument } from "./authentication-service";
import { heartbeatSchema } from "./schema";

export async function updateInstrumentHeartbeat(
  instrument: AuthedInstrument,
  raw: unknown,
) {
  const input = heartbeatSchema.parse(raw);
  const result = await db.instrument.updateMany({
    where: {
      id: instrument.id,
      organizationId: instrument.organizationId,
      active: true,
    },
    data: {
      lastSeenAt: new Date(),
      hostname: input.hostname,
      agentVersion: input.agentVersion,
      lastError: input.lastError,
      watchDirs: input.watchDirs,
    },
  });
  if (result.count !== 1) throw new Error("Active instrument not found.");
}
