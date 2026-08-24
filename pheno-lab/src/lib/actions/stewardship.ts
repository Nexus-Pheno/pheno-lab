"use server";

import { requireSession, type Session } from "@/lib/auth";
import {
  assertStewardship,
  getStewardships,
  hasStewardship,
  type Stewardship,
} from "@/modules/stewardship/service";

export type { Stewardship };

export async function assertSteward(kind: Stewardship): Promise<Session> {
  const session = await requireSession();
  await assertStewardship(session, kind);
  return session;
}

export async function hasSteward(kind: Stewardship): Promise<boolean> {
  const session = await requireSession();
  return hasStewardship(session, kind);
}

export async function mySteward(): Promise<Record<Stewardship, boolean>> {
  return getStewardships(await requireSession());
}
