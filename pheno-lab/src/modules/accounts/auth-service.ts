import "server-only";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import { loginSchema } from "./schema";

const DUMMY_HASH =
  "$2b$10$ZP3VxT2xmpxZQZ8iPtBBF.Nuf9bzaWKd9C74bgnQfWGhGxeebz4zC";

const byIdSchema = z.object({
  userId: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  organizationId: z.string().min(1).max(128),
});

/**
 * Password sign-in by user id — the tap-a-name path on shared tablets, where
 * the tile carries only the id so no email ever shows on a shared screen.
 * The caller must have verified the registered-device cookie and pass that
 * device's organization; the id only resolves inside it.
 */
export async function authenticateById(raw: unknown) {
  const parsed = byIdSchema.safeParse(raw);
  if (!parsed.success) return null;
  const user = await db.user.findFirst({
    where: {
      id: parsed.data.userId,
      organizationId: parsed.data.organizationId,
    },
    select: {
      id: true,
      name: true,
      role: true,
      organizationId: true,
      active: true,
      passwordHash: true,
      language: true,
    },
  });
  const matches = await bcrypt.compare(
    parsed.data.password,
    user?.passwordHash ?? DUMMY_HASH,
  );
  if (!user?.active || !matches) return null;
  return {
    actor: {
      uid: user.id,
      name: user.name,
      role: user.role,
      org: user.organizationId,
    },
    language: user.language === "zh" ? ("zh" as const) : ("en" as const),
  };
}

export async function authenticate(raw: unknown) {
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) return null;
  const user = await db.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      name: true,
      role: true,
      organizationId: true,
      active: true,
      passwordHash: true,
      language: true,
    },
  });
  const matches = await bcrypt.compare(
    parsed.data.password,
    user?.passwordHash ?? DUMMY_HASH,
  );
  if (!user?.active || !matches) return null;
  return {
    actor: {
      uid: user.id,
      name: user.name,
      role: user.role,
      org: user.organizationId,
    },
    language: user.language === "zh" ? ("zh" as const) : ("en" as const),
  };
}
