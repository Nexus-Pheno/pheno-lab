import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { badgeUidSchema, badgeTokenSchema } from "./schema";

// NFC work-badge login (NTAG213 stickers on the employees' ID cards).
//
// The threat model, decided 2026-09-07: the chip's UID is readable by any
// phone and clonable with "magic" tags, and the NDEF token is readable by any
// phone too — so neither is a secret against a determined insider. The real
// perimeter is that badge login is ONLY accepted from a registered shared
// tablet (device cookie), sessions get the kiosk rules, binding is audited,
// and a lost badge is unbound in one click. The UID+token pair merely stops
// casual mistakes and accidental cross-matches.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const hashesMatch = (a: string, b: string) => {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export type BadgeStatus = { bound: boolean; boundAt: string | null };

/**
 * Bind the tapped card to the signed-in user. `token` is the random value the
 * client just wrote onto the card ("" when the write failed — the tag may be
 * locked — leaving a UID-only badge). Rebinding replaces the previous card.
 */
export async function bindBadge(actor: Actor, raw: unknown): Promise<void> {
  const { uid, token } = (raw ?? {}) as { uid?: unknown; token?: unknown };
  const badgeUid = badgeUidSchema.parse(uid);
  const badgeToken = badgeTokenSchema.parse(token ?? "");

  await db.$transaction(async (tx) => {
    const taken = await tx.user.findFirst({
      where: { badgeUid, NOT: { id: actor.uid } },
      select: { id: true },
    });
    // Do not leak whose badge it is — just refuse.
    if (taken)
      throw new Error("This card is already bound to another account.");
    await tx.user.update({
      where: { id: actor.uid },
      data: {
        badgeUid,
        badgeSecretHash: badgeToken ? sha256(badgeToken) : "",
        badgeBoundAt: new Date(),
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "auth.badge_bound",
      entityType: "User",
      entityId: actor.uid,
      // The UID is an identifier, not a secret; the token never leaves here.
      changes: { badgeUid, hasToken: Boolean(badgeToken) },
    });
  });
}

export async function unbindBadge(actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.uid },
      data: { badgeUid: null, badgeSecretHash: "", badgeBoundAt: null },
    });
    await recordUserAudit(tx, {
      actor,
      action: "auth.badge_unbound",
      entityType: "User",
      entityId: actor.uid,
      changes: {},
    });
  });
}

/**
 * Resolve a tapped card to the account it signs in. The caller (transport)
 * must have already established that the request comes from a registered
 * shared device; `organizationId` is that device's organization, and the
 * badge only works inside it.
 */
export async function authenticateBadge(
  organizationId: string,
  raw: unknown,
): Promise<{
  actor: { uid: string; name: string; role: Actor["role"]; org: string };
  language: string;
} | null> {
  const { uid, token } = (raw ?? {}) as { uid?: unknown; token?: unknown };
  const badgeUid = badgeUidSchema.parse(uid);
  const badgeToken = badgeTokenSchema.parse(token ?? "");

  const user = await db.user.findFirst({
    where: { badgeUid, organizationId, active: true },
    select: {
      id: true,
      name: true,
      role: true,
      organizationId: true,
      language: true,
      badgeSecretHash: true,
    },
  });
  if (!user) return null;
  // A badge bound with an on-card token requires it; a UID-only badge
  // (locked tag at bind time) matches on UID alone.
  if (user.badgeSecretHash) {
    if (!badgeToken || !hashesMatch(user.badgeSecretHash, sha256(badgeToken)))
      return null;
  }

  await recordUserAudit(db, {
    actor: { uid: user.id, role: user.role, org: user.organizationId },
    action: "auth.badge_login",
    entityType: "User",
    entityId: user.id,
    changes: {},
  });

  return {
    actor: {
      uid: user.id,
      name: user.name,
      role: user.role,
      org: user.organizationId,
    },
    language: user.language,
  };
}
