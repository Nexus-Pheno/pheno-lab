import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { redirect } from "next/navigation";

const COOKIE = "pheno_session";
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET!);

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
    return {
      uid: payload.uid as string,
      name: payload.name as string,
      role: payload.role as Session["role"],
      org: payload.org as string,
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
  if (s.role === "TECHNICIAN") throw new Error("Technicians have read-only access.");
  return s;
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireSession();
  if (s.role !== "ADMIN") throw new Error("Only the organization admin can do this.");
  return s;
}
