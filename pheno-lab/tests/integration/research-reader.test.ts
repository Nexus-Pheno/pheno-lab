import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import {
  authenticateReader,
  issueReaderKey,
  revokeReaderKey,
  readerSettings,
} from "@/modules/research-reader/access";
import {
  parseReaderRequest,
  readResearch,
} from "@/modules/research-reader/query";
import type { Actor } from "@/modules/authorization/actor";
import { AuthorizationError } from "@/modules/authorization/policy";
import { createHash } from "node:crypto";

describe("delegated analysis reader", () => {
  const suffix = crypto.randomUUID();
  let actor: Actor, other: Actor;
  const minimal = {
    label: "CLI test",
    days: 1,
    reports: false,
    chemistry: false,
  };
  const query = (params: string) =>
    parseReaderRequest(new URLSearchParams(params))!;
  async function member(label: string): Promise<Actor> {
    const org = await db.organization.create({
      data: { slug: label + suffix, name: "Reader fixture", status: "ACTIVE" },
    });
    const user = await db.user.create({
      data: {
        name: "Fixture admin",
        email: label + suffix + "@example.test",
        passwordHash: "fixture",
        organizationId: org.id,
        role: "ADMIN",
        chemicalAccess: true,
        reportAccess: true,
      },
    });
    return { uid: user.id, org: org.id, role: user.role };
  }
  beforeAll(async () => {
    actor = await member("one");
    other = await member("two");
  });
  afterAll(async () => {
    for (const a of [actor, other].filter(Boolean)) {
      const where = { organizationId: a.org };
      await db.auditEvent.deleteMany({ where });
      await db.material.deleteMany({ where });
      await db.experiment.deleteMany({ where });
      await db.process.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: a.org } });
    }
    await db.$disconnect();
  });
  it("checks the active admin on a personal device and every optional grant", async () => {
    const kiosk = { ...actor, device: { id: "test" } };
    await expect(issueReaderKey(kiosk, minimal)).rejects.toThrow(
      AuthorizationError,
    );
    await expect(
      issueReaderKey({ ...actor, role: "MANAGER" }, minimal),
    ).rejects.toThrow(AuthorizationError);
    await db.user.update({
      where: { id: actor.uid },
      data: { chemicalAccess: false, reportAccess: false },
    });
    try {
      for (const scope of ["reports", "chemistry"])
        await expect(
          issueReaderKey(actor, { ...minimal, [scope]: true }),
        ).rejects.toThrow(AuthorizationError);
    } finally {
      await db.user.update({
        where: { id: actor.uid },
        data: { chemicalAccess: true, reportAccess: true },
      });
    }
  });
  it("pages across real visible experiments and reads app evidence; excludes foreign, test and deleted records", async () => {
    const make = (owner: Actor, tag: string, extra = {}) =>
      db.experiment.create({
        data: {
          organizationId: owner.org,
          createdById: owner.uid,
          code: suffix + tag,
          title: tag,
          ...extra,
        },
      });
    const first = await make(actor, "one");
    const second = await make(actor, "two");
    const foreign = await make(other, "outside");
    const test = await make(actor, "scratch", { isTest: true });
    await make(actor, "trash", { deletedAt: new Date() });
    const key = await issueReaderKey(actor, minimal);
    const reader = (await authenticateReader("Bearer " + key.secret))!;
    const seen: string[] = [];
    let cursor = "";
    do {
      const page = await readResearch(
        reader,
        query(
          "resource=experiments&limit=1" + (cursor ? "&after=" + cursor : ""),
        ),
      );
      if (!page || !("data" in page) || !Array.isArray(page.data))
        throw Error("invalid page");
      seen.push(page.data[0].id);
      expect(typeof page.data[0].createdAt).toBe("string");
      cursor = page.nextCursor ?? "";
    } while (cursor);
    expect(seen.sort()).toEqual([first.id, second.id].sort());
    for (const row of [test, foreign])
      expect(
        await readResearch(reader, query("resource=evidence&id=" + row.id)),
      ).toBeNull();
    expect(
      await readResearch(reader, query("resource=evidence&id=" + first.id)),
    ).toMatchObject({
      data: {
        policyVersion: "accepted-device-result-v1",
        experiment: { id: first.id },
      },
    });
  });
  it("isolates chemistry and reports, rechecks both grants, and exposes the full permitted catalog", async () => {
    const process = await db.process.create({
      data: { organizationId: actor.org, name: "Fixture", kind: "PROCESSING" },
    });
    const mat = await db.material.create({
      data: {
        organizationId: actor.org,
        name: "Fixture",
        processId: process.id,
        smiles: "CCC",
        properties: { legacy: { smiles: "CCC" } },
      },
    });
    const key = await issueReaderKey(actor, minimal);
    const reader = (await authenticateReader("Bearer " + key.secret))!;
    expect(
      await readResearch(reader, query("resource=materials")),
    ).toMatchObject({
      data: [{ id: mat.id, properties: { legacy: { smiles: "" } } }],
    });
    for (const resource of ["reports", "chemistry"])
      await expect(
        readResearch(reader, query("resource=" + resource)),
      ).rejects.toThrow(AuthorizationError);
    const full = await issueReaderKey(actor, {
      ...minimal,
      chemistry: true,
      reports: true,
    });
    const withScopes = (await authenticateReader("Bearer " + full.secret))!;
    const cat = await readResearch(withScopes, query(""));
    if (!cat || !("collections" in cat)) throw Error("no catalog");
    for (const collection of cat.collections!)
      expect(
        await readResearch(withScopes, query("resource=" + collection)),
      ).toHaveProperty("data");
    expect(
      await readResearch(withScopes, query("resource=chemistry")),
    ).toMatchObject({ data: [{ smiles: "CCC", validation: "UNVALIDATED" }] });
    await db.user.update({
      where: { id: actor.uid },
      data: { reportAccess: false, chemicalAccess: false },
    });
    try {
      expect(await authenticateReader("Bearer " + full.secret)).toMatchObject({
        reports: false,
        chemistry: false,
      });
    } finally {
      await db.user.update({
        where: { id: actor.uid },
        data: { reportAccess: true, chemicalAccess: true },
      });
    }
  });
  it("stores only a digest, enforces expiry, account lifecycle and owner-only revocation", async () => {
    const key = await issueReaderKey(actor, minimal);
    const auth = () => authenticateReader("Bearer " + key.secret);
    const stored = await db.researchReaderKey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.digest).toBe(
      createHash("sha256").update(key.secret).digest("hex"),
    );
    expect(JSON.stringify(await readerSettings(actor))).not.toContain(
      key.secret,
    );
    await revokeReaderKey(other, key.id);
    expect(await auth()).not.toBeNull();
    for (const [change, restore] of [
      [{ active: false }, { active: true }],
      [{ pendingApproval: true }, { pendingApproval: false }],
      [{ testingOnly: true }, { testingOnly: false }],
      [{ mustChangePassword: true }, { mustChangePassword: false }],
      [{ role: "MANAGER" as const }, { role: "ADMIN" as const }],
      [
        { sessionVersion: stored.sessionVersion + 1 },
        { sessionVersion: stored.sessionVersion },
      ],
    ]) {
      await db.user.update({ where: { id: actor.uid }, data: change });
      try {
        expect(await auth()).toBeNull();
      } finally {
        await db.user.update({ where: { id: actor.uid }, data: restore });
      }
    }
    await db.researchReaderKey.update({
      where: { id: key.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await auth()).toBeNull();
    await db.researchReaderKey.update({
      where: { id: key.id },
      data: { expiresAt: stored.expiresAt },
    });
    await revokeReaderKey(actor, key.id);
    expect(await auth()).toBeNull();
    expect(
      JSON.stringify(
        await db.auditEvent.findMany({ where: { entityId: key.id } }),
      ),
    ).not.toContain(key.secret);
  });
  it("rejects unsupported scopes and malformed selectors", () => {
    for (const q of [
      "org=another",
      "resource=users",
      "resource=chemistry&id=x",
      "resource=report",
      "limit=101",
      "resource=reports&resource=chemistry",
      "resource=materials&experiment=x",
    ])
      expect(parseReaderRequest(new URLSearchParams(q))).toBeNull();
  });
});
