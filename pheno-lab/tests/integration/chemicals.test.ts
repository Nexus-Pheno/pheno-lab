import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import {
  canOpenChemicals,
  exportChemicalDefinitions,
  getChemicalForAnalysis,
  listChemicals,
} from "@/modules/chemicals/query";
import {
  previewChemical,
  readChemicalStructure,
  saveChemicalRow,
} from "@/modules/chemicals/service";
import { getLibraryPageData } from "@/modules/library/query";
import { saveMaterialCard } from "@/modules/library/service";
import {
  listMaterialEdits,
  submitMaterialEdit,
} from "@/modules/library/review-service";
import {
  findDuplicates,
  getIngestPayload,
  listIngestItems,
  updateIngestPayload,
} from "@/modules/ingest/service";
import { canReadObject } from "@/modules/files/authorization";
import { getExperimentDesignerData } from "@/modules/experiments/query";
import {
  announceChemicalPortal,
  grantChemicalAccess,
  initializeSamRegistry,
} from "@/modules/chemicals/operator-service";
import * as auditWriter from "@/modules/audit/writer";

afterAll(() => db.$disconnect());
async function fixture() {
  const org = await db.organization.create({
    data: { name: "Chemical test", slug: `chem-${crypto.randomUUID()}` },
  });
  const foreign = await db.organization.create({
    data: {
      name: "Foreign chemical test",
      slug: `chem-other-${crypto.randomUUID()}`,
    },
  });
  const create = (
    role: "ADMIN" | "MANAGER" | "TECHNICIAN",
    extra: object = {},
  ) =>
    db.user.create({
      data: {
        organizationId: org.id,
        name: "Synthetic chemical user",
        email: `${crypto.randomUUID()}@example.test`,
        role,
        passwordHash: "test-only",
        ...extra,
      },
    });
  const owners = [
    await create("ADMIN", { chemicalAccess: true }),
    await create("MANAGER", { chemicalAccess: true }),
  ];
  const admin = await create("ADMIN"),
    ordinary = await create("MANAGER", {
      materialAdmin: true,
      reportAccess: true,
    }),
    technician = await create("TECHNICIAN"),
    restricted = await create("TECHNICIAN", {
      testingOnly: true,
      chemicalAccess: true,
    });
  const actor = (user: { id: string; role: Actor["role"] }): Actor => ({
    uid: user.id,
    org: org.id,
    role: user.role,
  });
  return {
    org,
    foreign,
    owners,
    admin,
    ordinary,
    technician,
    restricted,
    actor,
    async cleanup() {
      for (const organizationId of [org.id, foreign.id]) {
        const where = { organizationId };
        for (const row of await db.materialChemistry.findMany({
          where: { material: { organizationId } },
        }))
          await objectStorage().delete(row.structurePath);
        await db.experiment.deleteMany({ where });
        await db.materialEditSuggestion.deleteMany({ where });
        await db.ingestItem.deleteMany({ where });
        await db.feedback.deleteMany({ where });
        await db.notification.deleteMany({ where });
        await db.auditEvent.deleteMany({ where });
        await db.material.deleteMany({ where });
        await db.materialCategoryDef.deleteMany({ where });
        await db.user.deleteMany({ where });
        await db.organization.delete({ where: { id: organizationId } });
      }
    },
  };
}
const input = () => ({
  id: null,
  requestId: crypto.randomUUID(),
  expectedVersion: 0,
  name: "Synthetic SAM fixture",
  category: "SAM",
  smiles: "CCO",
});
const card = {
  name: "Public name",
  category: "SOLVENT",
  composition: "",
  smiles: "",
  casNumber: "",
  molecularWeight: "",
  purity: "",
  supplier: "",
  lot: "",
  properties: {},
  notes: "",
  processId: null,
};

describe("private chemical portal on real PostgreSQL", () => {
  it("announces the portal once to a current scoped maintainer without changing grants", async () => {
    const f = await fixture();
    try {
      const input = {
        organizationId: f.org.id,
        senderUserId: f.owners[0].id,
        recipientUserId: f.owners[1].id,
        authorizationReference: "Synthetic authorized welcome",
      };
      const audit = vi
        .spyOn(auditWriter, "recordSystemAudit")
        .mockRejectedValueOnce(new Error("Synthetic audit failure"));
      await expect(announceChemicalPortal(input)).rejects.toThrow(
        "Synthetic audit failure",
      );
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      audit.mockRestore();
      const attempts = await Promise.all([
        announceChemicalPortal(input),
        announceChemicalPortal(input),
      ]);
      expect(attempts.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ]);
      const notice = await db.notification.findFirstOrThrow({
        where: { organizationId: f.org.id },
      });
      expect(notice).toMatchObject({
        userId: f.owners[1].id,
        kind: "chemicals_ready",
        entityLabel: "Pheno Chemicals",
        href: "/chemicals",
        readAt: null,
      });
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "chemistry.portal.announced",
          },
        }),
      ).toBe(1);
      await expect(
        announceChemicalPortal({ ...input, organizationId: f.foreign.id }),
      ).rejects.toThrow();
      await expect(
        announceChemicalPortal({ ...input, recipientUserId: f.admin.id }),
      ).rejects.toThrow();
      await db.user.update({
        where: { id: f.owners[1].id },
        data: { chemicalAccess: false },
      });
      await expect(announceChemicalPortal(input)).rejects.toThrow();
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("keeps existing library materials intact while listing only explicitly registered SAM definitions", async () => {
    const f = await fixture();
    try {
      const actor = f.actor(f.owners[0]);
      const legacy = await db.material.create({
        data: {
          organizationId: f.org.id,
          name: "Existing SAM",
          category: "SAM",
          smiles: "CCO",
        },
      });
      expect((await listChemicals(actor, {})).total).toBe(0);
      const saved = await saveChemicalRow(actor, input());
      const page = await listChemicals(actor, {});
      expect(page.total).toBe(1);
      expect(page.rows.map((x) => x.id)).toEqual([saved.row.id]);
      await db.materialChemistry.update({
        where: { materialId: saved.row.id },
        data: { inSamRegistry: false },
      });
      expect((await listChemicals(actor, {})).total).toBe(0);
      expect(await readChemicalStructure(actor, saved.row.id)).not.toBeNull();
      expect(
        await db.material.findUnique({ where: { id: legacy.id } }),
      ).toMatchObject({ name: "Existing SAM", smiles: "CCO", archived: false });
      expect(
        (await getLibraryPageData(f.actor(f.technician))).materials,
      ).toHaveLength(2);
      expect((await exportChemicalDefinitions(actor)).materials).toHaveLength(
        2,
      );
    } finally {
      await f.cleanup();
    }
  });
  it("resets only portal membership atomically and idempotently, retaining materials and images", async () => {
    const f = await fixture();
    try {
      const actor = f.actor(f.owners[0]);
      const reference = await saveChemicalRow(actor, input());
      const other = await saveChemicalRow(actor, {
        ...input(),
        name: "Other synthetic SAM",
      });
      const evidence = await db.materialChemistry.findUniqueOrThrow({
        where: { materialId: reference.row.id },
      });
      const envelope = {
        organizationId: f.org.id,
        actorUserId: actor.uid,
        referenceMaterialId: reference.row.id,
        expectedDigest: reference.row.rowDigest,
        expectedStructureSha256: evidence.structureSha256,
        authorizationReference: "Synthetic authorized portal reset",
      };
      await expect(
        initializeSamRegistry({ ...envelope, actorUserId: f.ordinary.id }),
      ).rejects.toThrow();
      await expect(
        initializeSamRegistry({ ...envelope, organizationId: f.foreign.id }),
      ).rejects.toThrow();
      await expect(
        initializeSamRegistry({ ...envelope, expectedDigest: "0".repeat(64) }),
      ).rejects.toThrow("changed");
      const audit = vi
        .spyOn(auditWriter, "recordSystemAudit")
        .mockRejectedValueOnce(new Error("Synthetic audit failure"));
      await expect(initializeSamRegistry(envelope)).rejects.toThrow(
        "Synthetic audit failure",
      );
      audit.mockRestore();
      expect((await listChemicals(actor, {})).total).toBe(2);
      expect(await initializeSamRegistry(envelope)).toEqual({
        changed: true,
        visible: 1,
      });
      expect(await initializeSamRegistry(envelope)).toEqual({
        changed: false,
        visible: 1,
      });
      expect(
        (await listChemicals(actor, {})).rows.map((row) => row.id),
      ).toEqual([reference.row.id]);
      expect(
        await db.material.count({ where: { organizationId: f.org.id } }),
      ).toBe(2);
      expect(await readChemicalStructure(actor, other.row.id)).not.toBeNull();
      expect(
        await db.materialChemistry.findUnique({
          where: { materialId: reference.row.id },
        }),
      ).toMatchObject({
        structureSha256: evidence.structureSha256,
        version: 1,
      });
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "chemistry.sam_registry.initialized",
          },
        }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("provisions exactly two approved grants transactionally without an application admin bypass", async () => {
    const f = await fixture();
    try {
      await db.user.updateMany({
        where: { organizationId: f.org.id },
        data: { chemicalAccess: false },
      });
      const envelope = {
        organizationId: f.org.id,
        recipientIds: f.owners.map((u) => u.id),
        authorizationReference: "Synthetic approval for two test maintainers",
      };
      expect(await grantChemicalAccess(envelope)).toEqual({
        granted: 2,
        unchanged: 0,
      });
      expect(await grantChemicalAccess(envelope)).toEqual({
        granted: 0,
        unchanged: 2,
      });
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, chemicalAccess: true },
        }),
      ).toBe(2);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "user.chemical_access.granted",
          },
        }),
      ).toBe(2);
      await expect(
        grantChemicalAccess({
          ...envelope,
          recipientIds: [...envelope.recipientIds, f.admin.id],
        }),
      ).rejects.toThrow();
      await expect(
        grantChemicalAccess({
          ...envelope,
          recipientIds: [f.admin.id, f.ordinary.id],
        }),
      ).rejects.toThrow("Unexpected");
      await expect(
        grantChemicalAccess({
          ...envelope,
          recipientIds: [f.owners[0].id, f.technician.id],
        }),
      ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
  it("defaults deny, permits exactly designated grants, and rechecks revoked roles/accounts", async () => {
    const f = await fixture();
    try {
      for (const owner of f.owners)
        expect(await canOpenChemicals(f.actor(owner))).toBe(true);
      for (const user of [f.admin, f.ordinary, f.technician, f.restricted]) {
        expect(await canOpenChemicals(f.actor(user))).toBe(false);
        await expect(listChemicals(f.actor(user), {})).rejects.toThrow();
        await expect(previewChemical(f.actor(user), "CCO")).rejects.toThrow();
        await expect(saveChemicalRow(f.actor(user), input())).rejects.toThrow();
        await expect(
          exportChemicalDefinitions(f.actor(user)),
        ).rejects.toThrow();
      }
      const owner = f.owners[0],
        actor = f.actor(owner);
      for (const patch of [
        { chemicalAccess: false },
        { role: "TECHNICIAN" as const },
        { active: false },
        { pendingApproval: true },
        { mustChangePassword: true },
        { testingOnly: true },
      ]) {
        await db.user.update({ where: { id: owner.id }, data: patch });
        expect(await canOpenChemicals(actor)).toBe(false);
        await db.user.update({
          where: { id: owner.id },
          data: {
            chemicalAccess: true,
            role: "ADMIN",
            active: true,
            pendingApproval: false,
            mustChangePassword: false,
            testingOnly: false,
          },
        });
      }
      expect(
        await canOpenChemicals({
          ...actor,
          device: { id: "shared-test", label: "Shared" },
        } as Actor),
      ).toBe(false);
      await db.organization.update({
        where: { id: f.org.id },
        data: { status: "SUSPENDED" },
      });
      expect(await canOpenChemicals(actor)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it("saves validated structures atomically, retries once, rejects stale edits and keeps public selection", async () => {
    const f = await fixture();
    try {
      const actor = f.actor(f.owners[1]),
        envelope = input();
      const first = await saveChemicalRow(actor, envelope),
        retry = await saveChemicalRow(actor, envelope);
      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.row.id).toBe(first.row.id);
      expect(
        await db.material.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
      expect(
        (await readChemicalStructure(actor, first.row.id))?.byteLength,
      ).toBeGreaterThan(100);
      expect(
        await getChemicalForAnalysis(
          { ...actor, org: f.foreign.id },
          first.row.id,
        ).catch(() => null),
      ).toBeNull();
      await expect(
        readChemicalStructure(f.actor(f.ordinary), first.row.id),
      ).rejects.toThrow();
      const second = await saveChemicalRow(actor, {
        ...envelope,
        id: first.row.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        expectedDigest: first.row.rowDigest,
        smiles: "CO",
      });
      expect(second.row.chemistry?.version).toBe(2);
      await saveMaterialCard(f.actor(f.ordinary), first.row.id, {
        ...card,
        name: "Concurrent public label",
      });
      await expect(
        saveChemicalRow(actor, {
          ...envelope,
          id: first.row.id,
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          expectedDigest: second.row.rowDigest,
          smiles: "CO",
        }),
      ).rejects.toThrow("changed");
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: first.row.id } }))
          .name,
      ).toBe("Concurrent public label");
      await saveMaterialCard(f.actor(f.ordinary), first.row.id, {
        ...card,
        name: envelope.name,
      });
      await expect(
        saveChemicalRow(actor, {
          ...envelope,
          id: first.row.id,
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
        }),
      ).rejects.toThrow("changed");
      await expect(
        saveChemicalRow(actor, { ...envelope, requestId: crypto.randomUUID() }),
      ).rejects.toThrow("already exists");
      const library = await getLibraryPageData(f.actor(f.technician));
      expect(library.materials.find((m) => m.id === first.row.id)?.name).toBe(
        envelope.name,
      );
      expect(library.materials[0]).not.toHaveProperty("smiles");
      expect(library.materials[0]).not.toHaveProperty("chemistry");
      expect(library.categories.some((c) => c.code === "SAM")).toBe(true);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: { startsWith: "chemistry.material." },
          },
        }),
      ).toBe(2);
      const events = await db.auditEvent.findMany({
        where: { organizationId: f.org.id },
      });
      expect(JSON.stringify(events)).not.toContain('"smiles"');
      const exported = await exportChemicalDefinitions(actor);
      expect(exported.materials[0]).toMatchObject({
        smiles: "CO",
        validation: "VALIDATED_NOTATION",
      });
    } finally {
      await f.cleanup();
    }
  });
  it("blocks invalid chemistry without database/storage writes and compensates failed commits", async () => {
    const f = await fixture();
    try {
      const actor = f.actor(f.owners[0]);
      await expect(
        saveChemicalRow(actor, { ...input(), smiles: "C(C)(C)(C)(C)C" }),
      ).rejects.toThrow();
      expect(
        await db.material.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      const storage = objectStorage(),
        remove = vi.spyOn(storage, "delete"),
        put = vi.spyOn(storage, "put");
      // An actual PostgreSQL audit failure occurs after the upload and business write.
      const trigger = `chemical_failure_${crypto.randomUUID().replaceAll("-", "")}`;
      const orgId = f.org.id.replaceAll("'", "''");
      await db.$executeRawUnsafe(
        `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId"='${orgId}' AND NEW.action LIKE 'chemistry.material.%' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
      );
      try {
        await expect(saveChemicalRow(actor, input())).rejects.toThrow();
        expect(put).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(await storage.exists(put.mock.calls[0][0].key)).toBe(false);
        expect(
          await db.material.count({ where: { organizationId: f.org.id } }),
        ).toBe(0);
        expect(
          await db.materialChemistry.count({
            where: { material: { organizationId: f.org.id } },
          }),
        ).toBe(0);
        expect(
          await db.auditEvent.count({ where: { organizationId: f.org.id } }),
        ).toBe(0);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "AuditEvent"`);
        await db.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
        remove.mockRestore();
        put.mockRestore();
      }
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
  it("protects legacy SMILES in experiment payloads, material suggestions, intake and general files", async () => {
    const f = await fixture();
    try {
      const secret = "NCC(O)c1ccccc1";
      const material = await db.material.create({
        data: {
          organizationId: f.org.id,
          name: "Synthetic private legacy",
          smiles: secret,
        },
      });
      const experiment = await db.experiment.create({
        data: {
          organizationId: f.org.id,
          createdById: f.technician.id,
          code: `CHEM-${crypto.randomUUID()}`,
          title: "Public selector fixture",
        },
      });
      const designer = await getExperimentDesignerData(
        f.actor(f.technician),
        experiment.id,
      );
      expect(JSON.stringify(designer)).not.toContain(secret);
      await saveMaterialCard(f.actor(f.ordinary), material.id, {
        ...card,
        name: material.name,
      });
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .smiles,
      ).toBe(secret);
      await expect(
        saveMaterialCard(f.actor(f.ordinary), material.id, {
          ...card,
          smiles: secret,
        }),
      ).rejects.toThrow();
      const suggestion = await submitMaterialEdit(f.actor(f.technician), {
        materialId: material.id,
        changes: { ...card, name: material.name },
      });
      expect(suggestion.id).toBeTruthy();
      expect(
        JSON.stringify(await listMaterialEdits(f.actor(f.ordinary))),
      ).not.toContain(secret);
      const item = await db.ingestItem.create({
        data: {
          organizationId: f.org.id,
          kind: "MATERIAL",
          title: material.name,
          payload: { name: material.name, smiles: secret },
        },
      });
      expect(
        JSON.stringify(await getIngestPayload(f.actor(f.ordinary), item.id)),
      ).not.toContain(secret);
      expect(
        JSON.stringify(await listIngestItems(f.actor(f.ordinary))),
      ).not.toContain(secret);
      expect(
        JSON.stringify(
          await findDuplicates(f.actor(f.ordinary), "MATERIAL", {
            name: material.name,
            smiles: "CCC",
          }),
        ),
      ).not.toContain(secret);
      await updateIngestPayload(
        f.actor(f.ordinary),
        item.id,
        { name: material.name, smiles: "" },
        "",
      );
      expect(
        (await db.ingestItem.findUniqueOrThrow({ where: { id: item.id } }))
          .payload,
      ).toMatchObject({ smiles: secret });
      const saved = await saveChemicalRow(f.actor(f.owners[0]), input());
      const chemistry = await db.materialChemistry.findUniqueOrThrow({
        where: { materialId: saved.row.id },
      });
      await db.feedback.create({
        data: {
          organizationId: f.org.id,
          userId: f.ordinary.id,
          kind: "bug",
          message: "Synthetic chemistry pointer",
          screenshotPath: chemistry.structurePath,
        },
      });
      expect(
        await canReadObject(f.actor(f.ordinary), chemistry.structurePath),
      ).toBe(false);
      expect(
        await canReadObject(f.actor(f.owners[0]), chemistry.structurePath),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it("permits only SAM entries without changing other stewardship grants", async () => {
    const f = await fixture();
    try {
      for (const category of [
        "SOLVENT",
        "ADDITIVE",
        "OTHER",
        "FOREIGN_CATEGORY",
      ])
        await expect(
          saveChemicalRow(f.actor(f.owners[1]), { ...input(), category }),
        ).rejects.toThrow();
      expect(
        await db.material.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: f.owners[1].id } }))
          .materialAdmin,
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
