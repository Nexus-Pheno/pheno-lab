import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@/modules/authorization/actor";
import {
  beginStudy,
  finishStudy,
  savePart,
  readStudyPart,
  findStudyFile,
} from "@/modules/film-studies/service";
import { canOpenStudies } from "@/modules/film-studies/access";
import { listPublishedStudies } from "@/modules/film-studies/query";
import { PART_BYTES } from "@/modules/film-studies/schema";
import { supportedExtraction } from "@/modules/film-studies/interpretation";
import { searchMethods } from "@/modules/film-studies/methods";
import {
  authenticateReader,
  issueReaderKey,
} from "@/modules/research-reader/access";
import {
  parseReaderRequest,
  readResearch,
} from "@/modules/research-reader/query";
import { canReadObject } from "@/modules/files/authorization";
describe("independent characterizations", () => {
  let contributor: Actor, owner: Actor, foreign: Actor;
  const cleanup: string[] = [];
  async function org() {
    return (
      await db.organization.create({
        data: { slug: randomUUID(), name: "Film test" },
      })
    ).id;
  }
  async function user(org: string, role: Actor["role"], grant = false) {
    const u = await db.user.create({
      data: {
        name: "Test",
        email: randomUUID() + "@example.test",
        passwordHash: "fixture",
        role,
        organizationId: org,
        filmStudyAccess: grant,
      },
    });
    return { uid: u.id, role, org };
  }
  beforeAll(async () => {
    contributor = await user(await org(), "TECHNICIAN", true);
    owner = await user(contributor.org, "ADMIN");
    foreign = await user(await org(), "MANAGER", true);
  });
  afterAll(async () => {
    for (const key of cleanup) await objectStorage().delete(key);
    for (const organizationId of [contributor.org, foreign.org]) {
      const where = { organizationId };
      await db.auditEvent.deleteMany({ where });
      await db.filmStudy.deleteMany({ where });
      await db.material.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: organizationId } });
    }
  });
  it("offers bilingual methods, exact extracted evidence and separate account grants", async () => {
    for (const q of ["kpfm", "开尔文探针力", "Kelvin probe force"])
      expect(searchMethods(q).map((m) => m.code)).toContain("KPFM");
    expect(searchMethods("contact angle")[0].code).toBe("CA");
    const fields = {
      materials: ["film X"],
      samples: [],
      conditions: [],
      observations: [],
    };
    expect(supportedExtraction("film X on glass", fields)).toEqual(fields);
    expect(supportedExtraction("film Y", fields)).toBeNull();
    expect(await canOpenStudies(owner)).toBe(false);
    const kiosk = { ...contributor, device: { id: "fixture" } };
    expect(await canOpenStudies(kiosk)).toBe(false);
    expect(await canOpenStudies(contributor)).toBe(true);
  });
  it("resumes immutable parts, publishes once, searches notes & linked materials and gates originals", async () => {
    const material = await db.material.create({
      data: { organizationId: contributor.org, name: "Synthetic reference" },
    });
    const other = await db.material.create({
      data: { organizationId: foreign.org, name: "Elsewhere" },
    });
    const a = Buffer.alloc(PART_BYTES, 6),
      b = Buffer.from("tail");
    const id = randomUUID();
    const data = {
      id,
      method: "AFM",
      notes: "coupon A on glass",
      materialIds: [material.id],
      files: [{ name: "原始.spm", size: a.length + b.length }],
    };
    await expect(beginStudy(owner, data)).rejects.toThrow();
    await expect(
      beginStudy(contributor, { ...data, materialIds: [other.id] }),
    ).rejects.toThrow();
    const [draft, retry] = await Promise.all([
      beginStudy(contributor, data),
      beginStudy(contributor, data),
    ]);
    expect(draft).toEqual(retry);
    const file = draft.files[0];
    await expect(
      beginStudy(contributor, { ...data, notes: "altered" }),
    ).rejects.toThrow();
    await expect(finishStudy(contributor, id)).rejects.toThrow();
    expect(await listPublishedStudies(contributor.org, 10)).toHaveLength(0);
    await expect(savePart(foreign, file.id, 0, a)).rejects.toThrow();
    await expect(
      savePart(contributor, file.id, 1, Buffer.from("x")),
    ).rejects.toThrow();
    for (const [n, body] of [a, b].entries()) {
      const hash = createHash("sha256").update(body).digest("hex");
      cleanup.push(
        `organizations/${contributor.org}/film-studies/${file.id}/${n}-${hash}`,
      );
      await Promise.all([
        savePart(contributor, file.id, n, body),
        savePart(contributor, file.id, n, body),
      ]);
    }
    await expect(
      savePart(contributor, file.id, 1, Buffer.from("fail")),
    ).rejects.toThrow();
    await Promise.all([
      finishStudy(contributor, id),
      finishStudy(contributor, id),
    ]);
    expect(
      await db.auditEvent.count({
        where: { action: "filmStudy.saved", entityId: id },
      }),
    ).toBe(1);
    expect(
      await listPublishedStudies(contributor.org, 10, undefined, "原子力"),
    ).toHaveLength(1);
    expect(
      await listPublishedStudies(contributor.org, 10, undefined, "reference"),
    ).toHaveLength(1);
    expect(await listPublishedStudies(foreign.org, 10)).toHaveLength(0);
    expect(await findStudyFile(foreign.org, file.id)).toBeNull();
    expect(await canReadObject(owner, cleanup[0])).toBe(false);
    const input = {
      label: "fixture",
      days: 1,
      reports: false,
      chemistry: false,
    };
    await expect(
      issueReaderKey(owner, { ...input, filmStudies: true }),
    ).rejects.toThrow();
    await db.user.update({
      where: { id: owner.uid },
      data: { filmStudyAgentAccess: true },
    });
    const plain = await issueReaderKey(owner, input),
      scoped = await issueReaderKey(owner, { ...input, filmStudies: true });
    const get = async (secret: string, query: string) =>
      readResearch(
        (await authenticateReader("Bearer " + secret))!,
        parseReaderRequest(new URLSearchParams(query))!,
      );
    await expect(get(plain.secret, "resource=filmStudies")).rejects.toThrow();
    expect(
      (await get(scoped.secret, "resource=filmStudies"))?.data,
    ).toHaveLength(1);
    const part = (
      await get(
        scoped.secret,
        "resource=filmStudyFile&id=" + file.id + "&part=1",
      )
    )?.data as { body: string };
    expect(Buffer.from(part.body, "base64")).toEqual(b);
    expect(await canOpenStudies(owner)).toBe(false);
    await db.user.update({
      where: { id: owner.uid },
      data: { filmStudyAgentAccess: false },
    });
    await expect(
      get(scoped.secret, "resource=filmStudyFile&id=" + file.id),
    ).rejects.toThrow();
    const stored = await findStudyFile(contributor.org, file.id);
    await objectStorage().put({
      key: cleanup[1],
      body: Buffer.from("oops"),
      contentType: "application/octet-stream",
    });
    await expect(readStudyPart(contributor.org, stored!, 1)).rejects.toThrow(
      "integrity",
    );
  });
});
