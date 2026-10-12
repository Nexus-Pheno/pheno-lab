import "server-only";
import type { Prisma } from "@prisma/client";

export const registrationSelect = {
  id: true,
  name: true,
  category: true,
  smiles: true,
  archived: true,
  chemistry: { select: { version: true, inSamRegistry: true } },
} as const;
export type RegistrationMaterial = Prisma.MaterialGetPayload<{
  select: typeof registrationSelect;
}>;
export type RegistrationIssue = "exists" | "ambiguous" | "archived";

/** Resolve one existing library identity; never guess across archived or duplicate records. */
export function registrationTarget(
  matches: RegistrationMaterial[],
  name: string,
): { material: RegistrationMaterial | null; issue: RegistrationIssue | null } {
  const named = matches.filter(
    (row) => row.name.toLowerCase() === name.toLowerCase(),
  );
  const active = named.filter((row) => !row.archived);
  if (active.length > 1) return { material: null, issue: "ambiguous" };
  if (active.length === 1)
    return active[0].chemistry?.inSamRegistry
      ? { material: null, issue: "exists" }
      : { material: active[0], issue: null };
  return { material: null, issue: named.length ? "archived" : null };
}
