import "server-only";

import { randomBytes } from "node:crypto";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { deviceLabelSchema, deviceIdSchema, setupTokenSchema } from "./schema";

// Shared lab tablets. A device row is created by an admin, claimed once by
// opening its setup link on the tablet (which pins a signed cookie to that
// browser), and from then on every session created there runs under kiosk
// rules — see lib/auth.ts for the enforcement.

export type SharedDeviceRow = {
  id: string;
  label: string;
  createdAt: string;
  claimed: boolean;
  revoked: boolean;
  setupToken: string | null;
  currentUser: string | null;
  lastActivityAt: string | null;
};

const toRow = (d: {
  id: string;
  label: string;
  createdAt: Date;
  setupToken: string | null;
  revokedAt: Date | null;
  currentUser: { name: string } | null;
  lastActivityAt: Date | null;
}): SharedDeviceRow => ({
  id: d.id,
  label: d.label,
  createdAt: d.createdAt.toISOString(),
  claimed: d.setupToken === null,
  revoked: d.revokedAt !== null,
  setupToken: d.setupToken,
  currentUser: d.currentUser?.name ?? null,
  lastActivityAt: d.lastActivityAt ? d.lastActivityAt.toISOString() : null,
});

const DEVICE_SELECT = {
  id: true,
  label: true,
  createdAt: true,
  setupToken: true,
  revokedAt: true,
  currentUser: { select: { name: true } },
  lastActivityAt: true,
} as const;

export async function listDevices(actor: Actor): Promise<SharedDeviceRow[]> {
  assertAdmin(actor);
  const rows = await db.sharedDevice.findMany({
    where: { organizationId: actor.org },
    select: DEVICE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRow);
}

export async function createDevice(
  actor: Actor,
  rawLabel: unknown,
): Promise<SharedDeviceRow> {
  assertAdmin(actor);
  const label = deviceLabelSchema.parse(rawLabel);
  const setupToken = randomBytes(24).toString("base64url");
  return db.$transaction(async (tx) => {
    const device = await tx.sharedDevice.create({
      data: {
        organizationId: actor.org,
        label,
        setupToken,
        createdById: actor.uid,
      },
      select: DEVICE_SELECT,
    });
    await recordUserAudit(tx, {
      actor,
      action: "device.created",
      entityType: "SharedDevice",
      entityId: device.id,
      changes: { label },
    });
    return toRow(device);
  });
}

export async function revokeDevice(actor: Actor, rawId: unknown) {
  assertAdmin(actor);
  const id = deviceIdSchema.parse(rawId);
  await db.$transaction(async (tx) => {
    const device = await tx.sharedDevice.findFirst({
      where: { id, organizationId: actor.org },
      select: { id: true, revokedAt: true, label: true },
    });
    if (!device) throw new Error("No such device in this lab.");
    await tx.sharedDevice.update({
      where: { id: device.id },
      data: {
        revokedAt: device.revokedAt ? null : new Date(),
        currentUserId: null,
        // An unclaimed setup link dies with the revocation.
        ...(device.revokedAt ? {} : { setupToken: null }),
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: device.revokedAt ? "device.restored" : "device.revoked",
      entityType: "SharedDevice",
      entityId: device.id,
      changes: { label: device.label },
    });
  });
}

/** What the claim page shows before the confirm button is pressed. */
export async function peekSetupToken(
  rawToken: unknown,
): Promise<{ id: string; label: string } | null> {
  const token = setupTokenSchema.parse(rawToken);
  const device = await db.sharedDevice.findFirst({
    where: { setupToken: token, revokedAt: null },
    select: { id: true, label: true },
  });
  return device;
}

/**
 * Consume a setup token — called by the confirm action on the tablet itself,
 * with no session. Returns the device to pin into the browser cookie.
 */
export async function claimDevice(
  rawToken: unknown,
): Promise<{ id: string; label: string; organizationId: string } | null> {
  const token = setupTokenSchema.parse(rawToken);
  return db.$transaction(async (tx) => {
    const device = await tx.sharedDevice.findFirst({
      where: { setupToken: token, revokedAt: null },
      select: { id: true, label: true, organizationId: true },
    });
    if (!device) return null;
    await tx.sharedDevice.update({
      where: { id: device.id },
      data: { setupToken: null },
    });
    await recordSystemAudit(tx, {
      organizationId: device.organizationId,
      action: "device.claimed",
      entityType: "SharedDevice",
      entityId: device.id,
      metadata: { label: device.label },
    });
    return device;
  });
}

/**
 * The quick-pick name tiles on a registered tablet's login screen. Only ever
 * called with a verified device — team names and emails stay off the public
 * login page.
 */
export async function quickUsersForDevice(
  organizationId: string,
): Promise<{ name: string; email: string }[]> {
  const users = await db.user.findMany({
    where: { organizationId, active: true },
    select: { name: true, email: true },
    orderBy: { name: "asc" },
    take: 30,
  });
  return users;
}
