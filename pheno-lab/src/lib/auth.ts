import "server-only";

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { redirect } from "next/navigation";
import { serverConfig } from "@/infrastructure/config/server";
import { assertAdmin, assertStaff } from "@/modules/authorization/policy";
import { db } from "@/infrastructure/db/client";

const COOKIE = "pheno_session";
const secret = () => new TextEncoder().encode(serverConfig().SESSION_SECRET);

export type Session = {
  uid: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "TECHNICIAN";
  org: string; // organizationId — every query is scoped to this
};

export async function createSession(session: Session) {
  const token = await new SignJWT(session)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: serverConfig().SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.uid || !payload.org) return null;
    const user = await db.user.findUnique({
      where: { id: payload.uid as string },
      select: {
        id: true,
        name: true,
        role: true,
        organizationId: true,
        active: true,
      },
    });
    if (!user?.active) return null;
    return {
      uid: user.id,
      name: user.name,
      role: user.role,
      org: user.organizationId,
    };
  } catch {
    return null;
  }
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Admins and managers can create and edit; technicians cannot. */
export async function requireStaff(): Promise<Session> {
  const s = await requireSession();
  assertStaff(s);
  return s;
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireSession();
  assertAdmin(s);
  return s;
}
