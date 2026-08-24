import "server-only";

import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import { loginSchema } from "./schema";

const DUMMY_HASH =
  "$2b$10$ZP3VxT2xmpxZQZ8iPtBBF.Nuf9bzaWKd9C74bgnQfWGhGxeebz4zC";

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
