import { afterAll, afterEach, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  saveStepPreset,
  saveCharPreset,
  updatePreset,
  deletePreset,
  startPresetDraft,
  submitPresetForReview,
  reviewPresetPublication,
} from "@/modules/experiments/preset-service";
import {
  getPresetLibraryData,
  listUsablePresets,
} from "@/modules/experiments/preset-query";
import { getLibraryPageData } from "@/modules/library/query";
import {
  getExperimentDesignerData,
  getCaptureRunData,
} from "@/modules/experiments/query";
import {
  saveStep,
  saveCharacterization,
} from "@/modules/experiments/plan-service";
import { presetRevision } from "@/modules/experiments/preset-access";
import { parsePresetRef } from "@/modules/experiments/preset-policy";
import * as audit from "@/modules/audit/writer";
import {
  authenticateReader,
  issueReaderKey,
} from "@/modules/research-reader/access";
import {
  parseReaderRequest,
  readResearch,
} from "@/modules/research-reader/query";

afterAll(() => db.$disconnect());
afterEach(() => vi.restoreAllMocks());
const payload = (value = "personal-value") => ({
  equipmentId: null,
  environmentId: null,
  environmentConditions: {},
  materials: [],
  parameters: [
    { name: "Personal parameter", unit: "u", value, source: "custom" },
  ],
});
const charPayload = {
  equipmentId: null,
  environmentId: null,
  environmentConditions: {},
  settings: { reading: "private-reading" },
  sampleScope: "per-group",
};
async function fixture() {
  const org = await db.organization.create({
    data: { name: "Preset fixture", slug: `preset-${crypto.randomUUID()}` },
  });
  const actors: Actor[] = [];
  for (const role of [
    "ADMIN",
    "MANAGER",
    "TECHNICIAN",
    "TECHNICIAN",
  ] as const) {
    const u = await db.user.create({
      data: {
        organizationId: org.id,
        name: role,
        email: `${crypto.randomUUID()}@example.test`,
        role,
        passwordHash: "test-only",
      },
    });
    actors.push({ uid: u.id, org: org.id, role });
  }
  const [admin, manager, owner, other] = actors;
  const process = await db.process.create({
    data: {
      organizationId: org.id,
      name: "Preset process",
      kind: "PROCESSING",
    },
  });
  const charProcess = await db.process.create({
    data: {
      organizationId: org.id,
      name: "Preset characterization",
      kind: "CHARACTERIZATION",
    },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId: org.id,
      createdById: owner.uid,
      assigneeId: other.uid,
      code: `PRESET-${crypto.randomUUID()}`,
      title: "Preset experiment",
      samples: { create: { code: "S1" } },
      runs: { create: { runNo: 1 } },
      steps: {
        create: { processId: process.id, name: "Original step", position: 0 },
      },
      characterizations: {
        create: {
          processId: charProcess.id,
          name: "Original characterization",
          position: 0,
        },
      },
    },
    include: { steps: true, runs: true, characterizations: true },
  });
  return {
    org,
    admin,
    manager,
    owner,
    other,
    process,
    charProcess,
    experiment,
    async personal(kind: "STEP" | "CHARACTERIZATION" = "STEP") {
      return kind === "STEP"
        ? saveStepPreset(owner, "Private fixture", process.id, payload())
        : saveCharPreset(
            owner,
            "Private characterization",
            charProcess.id,
            charPayload,
          );
    },
    async revision(id: string) {
      const data = await getPresetLibraryData(owner);
      return data.personalPresets.find((p) => p.id === id)!.revision;
    },
    async cleanup() {
      const where = { organizationId: org.id };
      await db.presetPublicationRequest.deleteMany({ where });
      await db.personalPreset.deleteMany({ where });
      await db.preset.deleteMany({ where });
      await db.notification.deleteMany({ where });
      await db.auditEvent.deleteMany({ where });
      await db.experiment.deleteMany({ where });
      await db.label.deleteMany({ where });
      await db.equipment.deleteMany({ where });
      await db.process.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: org.id } });
    },
  };
}

it("keeps technician presets outside the public table and every other account's library/designer/capture choices", async () => {
  const f = await fixture();
  try {
    const privatePreset = await f.personal();
    expect(privatePreset.scope).toBe("PERSONAL");
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      0,
    );
    expect((await listUsablePresets(f.owner)).map((p) => p.id)).toContain(
      privatePreset.id,
    );
    for (const actor of [f.other, f.manager, f.admin]) {
      expect(await listUsablePresets(actor)).toEqual([]);
      expect(JSON.stringify(await getLibraryPageData(actor))).not.toContain(
        "personal-value",
      );
      expect(
        JSON.stringify(await getExperimentDesignerData(actor, f.experiment.id)),
      ).not.toContain("personal-value");
      expect(
        JSON.stringify(await getCaptureRunData(actor, f.experiment.id)),
      ).not.toContain("personal-value");
    }
    expect(
      JSON.stringify(await getCaptureRunData(f.owner, f.experiment.id)),
    ).toContain("personal-value");
    const key = await issueReaderKey(f.admin, {
      label: "Preset isolation test",
      days: 1,
      reports: false,
      chemistry: false,
    });
    const reader = (await authenticateReader("Bearer " + key.secret))!;
    const request = parseReaderRequest(
      new URLSearchParams("resource=presets"),
    )!;
    expect(await readResearch(reader, request)).toMatchObject({ data: [] });
  } finally {
    await f.cleanup();
  }
});

it("allows managers/admins to edit and delete public presets and rejects technicians, foreign references and stale edits", async () => {
  const f = await fixture();
  const foreign = await fixture();
  try {
    const published = await saveStepPreset(
      f.manager,
      "Public fixture",
      f.process.id,
      payload("public-value"),
    );
    expect(published.scope).toBe("PUBLIC");
    const revision = presetRevision(published);
    await expect(
      updatePreset(f.owner, published.id, { name: "forbidden" }, revision),
    ).rejects.toThrow();
    await expect(
      deletePreset(f.owner, published.id, revision),
    ).rejects.toThrow();
    await expect(
      updatePreset(foreign.admin, published.id, { name: "foreign" }, revision),
    ).rejects.toThrow();
    await expect(
      updatePreset(f.manager, published.id, { payload: charPayload }, revision),
    ).rejects.toThrow();
    await updatePreset(
      f.admin,
      published.id,
      { name: "Corrected public" },
      revision,
    );
    await expect(
      updatePreset(f.manager, published.id, { name: "stale" }, revision),
    ).rejects.toThrow("stale");
    await expect(
      deletePreset(f.manager, published.id, revision),
    ).rejects.toThrow("stale");
    const current = await db.preset.findUniqueOrThrow({
      where: { id: published.id },
    });
    await deletePreset(f.manager, published.id, presetRevision(current));
    expect(
      await db.preset.findUnique({ where: { id: published.id } }),
    ).toBeNull();
  } finally {
    await f.cleanup();
    await foreign.cleanup();
  }
});

it("limits personal edit/delete/use to its owner, including direct forged IDs from a manager or another experiment editor", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    const revision = await f.revision(p.id);
    for (const actor of [f.other, f.manager, f.admin]) {
      await expect(
        updatePreset(actor, p.id, { name: "leak" }, revision),
      ).rejects.toThrow();
      await expect(deletePreset(actor, p.id, revision)).rejects.toThrow();
      await expect(
        submitPresetForReview(actor, p.id, revision),
      ).rejects.toThrow();
      await expect(
        saveStep(
          actor,
          f.experiment.steps[0].id,
          {
            name: "should roll back",
            equipmentId: null,
            environmentId: null,
            environmentConditions: {},
            recipeId: null,
            layer: "",
            notes: "",
            materials: [],
            parameters: [],
          },
          p.id,
        ),
      ).rejects.toThrow();
      expect(
        (
          await db.processStep.findUniqueOrThrow({
            where: { id: f.experiment.steps[0].id },
          })
        ).name,
      ).toBe("Original step");
    }
    await saveStep(
      f.owner,
      f.experiment.steps[0].id,
      {
        name: "Applied privately",
        equipmentId: null,
        environmentId: null,
        environmentConditions: {},
        recipeId: null,
        layer: "",
        notes: "",
        materials: [],
        parameters: [],
      },
      p.id,
    );
    expect(
      (
        await db.personalPreset.findUniqueOrThrow({
          where: { id: parsePresetRef(p.id).id },
        })
      ).usageCount,
    ).toBe(1);
    await updatePreset(f.owner, p.id, { name: "Updated privately" }, revision);
    await expect(deletePreset(f.owner, p.id, revision)).rejects.toThrow(
      "stale",
    );
    await deletePreset(f.owner, p.id, await f.revision(p.id));
    expect(await listUsablePresets(f.owner)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it.each(["MANAGER", "ADMIN"] as const)(
  "publishes an immutable personal snapshot only after %s approval",
  async (role) => {
    const f = await fixture();
    try {
      const p = await f.personal();
      const request = await submitPresetForReview(
        f.owner,
        p.id,
        await f.revision(p.id),
      );
      expect(
        (await getPresetLibraryData(f.manager)).presetReviews,
      ).toHaveLength(1);
      expect(await listUsablePresets(f.manager)).toEqual([]);
      await expect(
        reviewPresetPublication(f.other, {
          id: request.id,
          decision: "APPROVED",
        }),
      ).rejects.toThrow();
      const reviewer = role === "ADMIN" ? f.admin : f.manager;
      await reviewPresetPublication(reviewer, {
        id: request.id,
        decision: "APPROVED",
      });
      const published = await db.preset.findFirstOrThrow({
        where: { organizationId: f.org.id },
      });
      expect(published.name).toBe("Private fixture");
      expect(published.payload).toEqual(payload());
      expect(published.createdById).toBe(reviewer.uid);
      expect((await listUsablePresets(f.other)).map((p) => p.id)).toEqual([
        published.id,
      ]);
      await expect(
        reviewPresetPublication(reviewer, {
          id: request.id,
          decision: "APPROVED",
        }),
      ).rejects.toThrow("not_pending");
      expect(
        await db.preset.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  },
);

it("keeps the approved public version while its author edits, rejects, resubmits and replaces it", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    let req = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    await reviewPresetPublication(f.manager, {
      id: req.id,
      decision: "APPROVED",
    });
    const published = await db.preset.findFirstOrThrow({
      where: { organizationId: f.org.id },
    });
    await updatePreset(
      f.owner,
      p.id,
      { name: "Revised private", payload: payload("revised-value") },
      await f.revision(p.id),
    );
    expect(
      (await db.preset.findUniqueOrThrow({ where: { id: published.id } }))
        .payload,
    ).toEqual(payload());
    req = await submitPresetForReview(f.owner, p.id, await f.revision(p.id));
    await expect(
      reviewPresetPublication(f.admin, {
        id: req.id,
        decision: "REJECTED",
        reason: "",
      }),
    ).rejects.toThrow();
    await reviewPresetPublication(f.admin, {
      id: req.id,
      decision: "REJECTED",
      reason: "Check the temperature",
    });
    expect((await listUsablePresets(f.other))[0].name).toBe("Private fixture");
    req = await submitPresetForReview(f.owner, p.id, await f.revision(p.id));
    await reviewPresetPublication(f.admin, {
      id: req.id,
      decision: "APPROVED",
    });
    const updated = await db.preset.findUniqueOrThrow({
      where: { id: published.id },
    });
    expect(updated.name).toBe("Revised private");
    expect(updated.payload).toEqual(payload("revised-value"));
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      1,
    );
  } finally {
    await f.cleanup();
  }
});

it("cancels pending review on author edit or deletion and retains a published copy when its personal copy is removed", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    const req = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    await updatePreset(
      f.owner,
      p.id,
      { name: "Changed after submission" },
      await f.revision(p.id),
    );
    expect(
      (
        await db.presetPublicationRequest.findUniqueOrThrow({
          where: { id: req.id },
        })
      ).status,
    ).toBe("CANCELLED");
    await expect(
      reviewPresetPublication(f.manager, { id: req.id, decision: "APPROVED" }),
    ).rejects.toThrow("not_pending");
    const req2 = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    await reviewPresetPublication(f.manager, {
      id: req2.id,
      decision: "APPROVED",
    });
    const published = await db.preset.findFirstOrThrow({
      where: { organizationId: f.org.id },
    });
    await deletePreset(f.owner, p.id, await f.revision(p.id));
    expect(
      await db.preset.findUnique({ where: { id: published.id } }),
    ).not.toBeNull();
    expect(
      (
        await db.presetPublicationRequest.findUniqueOrThrow({
          where: { id: req2.id },
        })
      ).personalPresetId,
    ).toBeNull();
    const restored = await startPresetDraft(f.owner, published.id);
    expect(restored.scope).toBe("PERSONAL");
    const again = await startPresetDraft(f.owner, published.id);
    expect(again.id).toBe(restored.id);
  } finally {
    await f.cleanup();
  }
});

it("blocks stale public replacement after a manager edit, and never recreates a deleted public target", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    let req = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    await reviewPresetPublication(f.manager, {
      id: req.id,
      decision: "APPROVED",
    });
    const published = await db.preset.findFirstOrThrow({
      where: { organizationId: f.org.id },
    });
    await updatePreset(
      f.owner,
      p.id,
      { name: "Proposed new name" },
      await f.revision(p.id),
    );
    req = await submitPresetForReview(f.owner, p.id, await f.revision(p.id));
    await updatePreset(
      f.admin,
      published.id,
      { name: "Manager revision" },
      presetRevision(published),
    );
    await expect(
      reviewPresetPublication(f.manager, { id: req.id, decision: "APPROVED" }),
    ).rejects.toThrow("stale");
    const current = await db.preset.findUniqueOrThrow({
      where: { id: published.id },
    });
    expect(current.name).toBe("Manager revision");
    await deletePreset(f.admin, published.id, presetRevision(current));
    await expect(
      reviewPresetPublication(f.manager, { id: req.id, decision: "APPROVED" }),
    ).rejects.toThrow("not_pending");
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      0,
    );
  } finally {
    await f.cleanup();
  }
});

it("serializes duplicate submissions and competing reviewers without duplicate public copies", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    const version = await f.revision(p.id);
    const attempts = await Promise.allSettled([
      submitPresetForReview(f.owner, p.id, version),
      submitPresetForReview(f.owner, p.id, version),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const req = await db.presetPublicationRequest.findFirstOrThrow({
      where: { organizationId: f.org.id, status: "PENDING" },
    });
    const decisions = await Promise.allSettled([
      reviewPresetPublication(f.manager, { id: req.id, decision: "APPROVED" }),
      reviewPresetPublication(f.admin, { id: req.id, decision: "APPROVED" }),
    ]);
    expect(decisions.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      1,
    );
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.org.id,
          action: "library.preset.publication_approved",
        },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("rechecks fresh roles and rejects foreign resources and restricted accounts", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const p = await f.personal();
    const rev = await f.revision(p.id);
    await expect(
      updatePreset(other.admin, p.id, { name: "foreign" }, rev),
    ).rejects.toThrow();
    await expect(
      saveStepPreset(f.owner, "Foreign process", other.process.id, payload()),
    ).rejects.toThrow();
    const request = await submitPresetForReview(f.owner, p.id, rev);
    await db.user.update({
      where: { id: f.manager.uid },
      data: { role: "TECHNICIAN" },
    });
    await expect(
      reviewPresetPublication(f.manager, {
        id: request.id,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("forbidden");
    for (const flags of [
      { testingOnly: true },
      { mustChangePassword: true },
      { active: false },
      { pendingApproval: true },
    ]) {
      await db.user.update({ where: { id: f.other.uid }, data: flags });
      await expect(
        saveStepPreset(f.other, "Restricted", f.process.id, payload()),
      ).rejects.toThrow();
      await db.user.update({
        where: { id: f.other.uid },
        data: {
          testingOnly: false,
          mustChangePassword: false,
          active: true,
          pendingApproval: false,
        },
      });
    }
    const char = await f.personal("CHARACTERIZATION");
    expect(
      (await listUsablePresets(f.owner)).some((p) => p.id === char.id),
    ).toBe(true);
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
});

it("rolls publication and its notification back if audit recording fails", async () => {
  const f = await fixture();
  try {
    const p = await f.personal();
    const req = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    const notices = await db.notification.count({
      where: { organizationId: f.org.id },
    });
    vi.spyOn(audit, "recordUserAudit").mockRejectedValueOnce(
      new Error("Audit unavailable"),
    );
    await expect(
      reviewPresetPublication(f.admin, { id: req.id, decision: "APPROVED" }),
    ).rejects.toThrow("Audit unavailable");
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      0,
    );
    expect(
      (
        await db.presetPublicationRequest.findUniqueOrThrow({
          where: { id: req.id },
        })
      ).status,
    ).toBe("PENDING");
    expect(
      await db.notification.count({ where: { organizationId: f.org.id } }),
    ).toBe(notices);
  } finally {
    await f.cleanup();
  }
});

it("applies and reviews characterization presets with the same owner isolation and public replacement rules", async () => {
  const f = await fixture();
  try {
    const p = await f.personal("CHARACTERIZATION");
    const draft = {
      ...charPayload,
      name: "Personal characterization applied",
      notes: "",
    };
    const id = f.experiment.characterizations[0].id;
    await expect(
      saveCharacterization(f.other, id, draft, p.id),
    ).rejects.toThrow("not_found");
    expect(
      (await db.characterization.findUniqueOrThrow({ where: { id } })).name,
    ).toBe("Original characterization");
    await saveCharacterization(f.owner, id, draft, p.id);
    expect(
      (
        await db.personalPreset.findUniqueOrThrow({
          where: { id: parsePresetRef(p.id).id },
        })
      ).usageCount,
    ).toBe(1);
    const request = await submitPresetForReview(
      f.owner,
      p.id,
      await f.revision(p.id),
    );
    await reviewPresetPublication(f.admin, {
      id: request.id,
      decision: "APPROVED",
    });
    const published = await db.preset.findFirstOrThrow({
      where: { organizationId: f.org.id },
    });
    expect(published.kind).toBe("CHARACTERIZATION");
    await saveCharacterization(f.other, id, draft, published.id);
    await expect(
      saveStep(
        f.owner,
        f.experiment.steps[0].id,
        {
          name: "Wrong kind",
          equipmentId: null,
          environmentId: null,
          environmentConditions: {},
          recipeId: null,
          layer: "",
          notes: "",
          materials: [],
          parameters: [],
        },
        published.id,
      ),
    ).rejects.toThrow("not_found");
  } finally {
    await f.cleanup();
  }
});

it("validates every preset payload reference against the organization and process", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const foreignEquipment = await db.equipment.create({
      data: {
        organizationId: other.org.id,
        processId: other.process.id,
        name: "Foreign fixture equipment",
      },
    });
    const wrongProcessEquipment = await db.equipment.create({
      data: {
        organizationId: f.org.id,
        processId: f.charProcess.id,
        name: "Wrong process equipment",
      },
    });
    const foreignEnvironment = await db.labEnvironment.create({
      data: {
        organizationId: other.org.id,
        name: "Foreign fixture environment",
      },
    });
    const foreignMaterial = await db.material.create({
      data: { organizationId: other.org.id, name: "Foreign fixture material" },
    });
    try {
      for (const extra of [
        { equipmentId: foreignEquipment.id },
        { equipmentId: wrongProcessEquipment.id },
        { environmentId: foreignEnvironment.id },
        { materials: [{ materialId: foreignMaterial.id, amount: "1" }] },
      ]) {
        await expect(
          saveStepPreset(f.owner, "Invalid reference", f.process.id, {
            ...payload(),
            ...extra,
          }),
        ).rejects.toThrow();
      }
      expect(
        await db.personalPreset.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
    } finally {
      await db.labEnvironment.delete({ where: { id: foreignEnvironment.id } });
      await db.material.delete({ where: { id: foreignMaterial.id } });
    }
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
});
