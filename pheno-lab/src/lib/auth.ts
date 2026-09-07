import "server-only";

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { redirect } from "next/navigation";
import { serverConfig } from "@/infrastructure/config/server";
import { assertAdmin, assertStaff } from "@/modules/authorization/policy";
import { db } from "@/infrastructure/db/client";

const COOKIE = "pheno_session";
const DEVICE_COOKIE = "pheno_device";
const secret = () => new TextEncoder().encode(serverConfig().SESSION_SECRET);

// Kiosk rules for sessions on a registered shared tablet. The device row is
// the source of truth: one active user at a time (a new login displaces the
// old session), idle timeout, and an absolute cap per sign-in. Personal
// phones never carry the device cookie and keep normal 30-day sessions.
// Idle window is 1 hour (was 15 min): experiments run 2h+ with long gaps
// where nothing needs entering, and a forgotten logout is already covered
// by the next person's sign-in displacing the session (tech feedback via
// Michael, 2026-09-07).
const KIOSK_IDLE_MS = 60 * 60_000;
const KIOSK_ABSOLUTE_MS = 12 * 3600_000;
const KIOSK_TOUCH_THROTTLE_MS = 60_000;

export type Session = {
  uid: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "TECHNICIAN";
  org: string; // organizationId — every query is scoped to this
  /** Present when this session runs on a registered shared tablet. */
  device?: { id: string; label: string };
};

/** Pin a claimed shared device to this browser. */
export async function setDeviceCookie(deviceId: string) {
  const token = await new SignJWT({ dev: deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret());
  (await cookies()).set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: serverConfig().SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365 * 2,
  });
}

/**
 * The registered, unrevoked shared device this browser is pinned to, if any.
 * Reads the device cookie and checks the row — used by the login screen (to
 * show the kiosk badge and name tiles) and by session creation.
 */
export async function getDevice(): Promise<{
  id: string;
  label: string;
  organizationId: string;
} | null> {
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.dev !== "string") return null;
    const device = await db.sharedDevice.findFirst({
      where: { id: payload.dev, revokedAt: null },
      select: { id: true, label: true, organizationId: true },
    });
    return device;
  } catch {
    return null;
  }
}

export async function createSession(session: Session) {
  // A login on a registered tablet becomes a kiosk session: the session
  // token names the device, and the device row records who holds it — which
  // instantly signs out whoever forgot to log out before.
  const device = await getDevice();
  const onDevice = device && device.organizationId === session.org;
  if (onDevice) {
    await db.sharedDevice.update({
      where: { id: device.id },
      data: { currentUserId: session.uid, lastActivityAt: new Date() },
    });
  }

  const token = await new SignJWT({
    uid: session.uid,
    name: session.name,
    role: session.role,
    org: session.org,
    ...(onDevice ? { dev: device.id } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
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
        lastSeenAt: true,
      },
    });
    if (!user?.active) return null;

    // Kiosk enforcement, server-side: the shared-tablet session dies when it
    // idles out, ages out, or someone else signs in on the same tablet.
    let device: Session["device"];
    if (typeof payload.dev === "string") {
      const row = await db.sharedDevice.findFirst({
        where: { id: payload.dev, revokedAt: null },
        select: {
          id: true,
          label: true,
          currentUserId: true,
          lastActivityAt: true,
        },
      });
      if (!row || row.currentUserId !== user.id) return null;
      const now = Date.now();
      const idleSince = row.lastActivityAt?.getTime() ?? 0;
      const issuedAt = typeof payload.iat === "number" ? payload.iat * 1000 : 0;
      if (now - idleSince > KIOSK_IDLE_MS) return null;
      if (!issuedAt || now - issuedAt > KIOSK_ABSOLUTE_MS) return null;
      if (now - idleSince > KIOSK_TOUCH_THROTTLE_MS) {
        void db.sharedDevice
          .update({
            where: { id: row.id },
            data: { lastActivityAt: new Date() },
          })
          .catch(() => {});
      }
      device = { id: row.id, label: row.label };
    }

    // Presence heartbeat for the activity monitor — at most one write per
    // 5 minutes per user, never blocking the request.
    if (
      !user.lastSeenAt ||
      Date.now() - user.lastSeenAt.getTime() > 5 * 60_000
    ) {
      void db.user
        .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
    }
    return {
      uid: user.id,
      name: user.name,
      role: user.role,
      org: user.organizationId,
      ...(device ? { device } : {}),
    };
  } catch {
    return null;
  }
}

export async function destroySession() {
  const store = await cookies();
  // Free the shared tablet for the next person when a kiosk session ends.
  const token = store.get(COOKIE)?.value;
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      if (typeof payload.dev === "string" && typeof payload.uid === "string") {
        await db.sharedDevice
          .updateMany({
            where: { id: payload.dev, currentUserId: payload.uid },
            data: { currentUserId: null },
          })
          .catch(() => {});
      }
    } catch {
      // An unreadable token still gets deleted below.
    }
  }
  store.delete(COOKIE);
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/**
 * Pages a shared lab tablet has no business showing — admin consoles,
 * exports, credentials. Kiosk sessions bounce to the home board; the same
 * person gets full access from their own phone or computer.
 */
export function assertPersonalDevice(session: Session) {
  if (session.device) redirect("/");
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
