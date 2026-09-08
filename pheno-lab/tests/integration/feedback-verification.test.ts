import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  reviewFeedback,
  submitFeedback,
  verifyFeedback,
} from "@/modules/accounts/profile-service";
import { listFeedback } from "@/modules/accounts/query";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.notification.deleteMany({ where: { organizationId } });
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.feedback.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Loop Org", slug: `fbloop-${suffix}` },
  });
  const person = async (label: string, role: "ADMIN" | "TECHNICIAN") => {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: `${label}-${suffix}@example.test`,
        name: label,
        passwordHash: "test-only",
        role,
      },
    });
    const actor: Actor = { uid: user.id, org: organization.id, role };
    return actor;
  };
  const admin = await person("Admin", "ADMIN");
  const reporter = await person("Reporter", "TECHNICIAN");
  const other = await person("Other", "TECHNICIAN");
  const feedback = await submitFeedback(reporter, {
    kind: "bug",
    title: "Timer drift",
    message: "The clock is wrong",
  });
  return { organization, admin, reporter, other, feedback };
}

describe("feedback verification loop against PostgreSQL", () => {
  it("requires patch notes to implement and notifies the reporter", async () => {
    const f = await fixture();
    try {
      await reviewFeedback(f.admin, {
        id: f.feedback.id,
        status: "approved",
        adminNote: "good catch",
      });
      // Implemented without patch notes is refused by the schema.
      await expect(
        reviewFeedback(f.admin, { id: f.feedback.id, status: "implemented" }),
      ).rejects.toThrow();

      await reviewFeedback(f.admin, {
        id: f.feedback.id,
        status: "implemented",
        implementationNote: "Fixed timezone handling; times now show CST.",
      });
      const row = await db.feedback.findUniqueOrThrow({
        where: { id: f.feedback.id },
      });
      expect(row.status).toBe("implemented");
      expect(row.implementedAt).not.toBeNull();
      expect(row.implementationNote).toContain("timezone");
      expect(
        await db.notification.count({
          where: { userId: f.reporter.uid, kind: "feedback_implemented" },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("lets only the reporter green-light, and a dispute returns to the admin", async () => {
    const f = await fixture();
    try {
      await reviewFeedback(f.admin, {
        id: f.feedback.id,
        status: "implemented",
        implementationNote: "done",
      });

      // Not the reporter, not before implementation, not without a reason.
      await expect(
        verifyFeedback(f.other, { id: f.feedback.id, accept: true }),
      ).rejects.toThrow(/reporter/i);
      await expect(
        verifyFeedback(f.reporter, {
          id: f.feedback.id,
          accept: false,
          note: "",
        }),
      ).rejects.toThrow();

      // Dispute with a reason → reopened, reviewer notified.
      await verifyFeedback(f.reporter, {
        id: f.feedback.id,
        accept: false,
        note: "Still shows UTC on the capture page.",
      });
      let row = await db.feedback.findUniqueOrThrow({
        where: { id: f.feedback.id },
      });
      expect(row.status).toBe("reopened");
      expect(row.disputeNote).toContain("UTC");
      expect(
        await db.notification.count({
          where: { userId: f.admin.uid, kind: "feedback_reopened" },
        }),
      ).toBe(1);

      // Second pass: re-implement (resets verdict), reporter approves.
      await reviewFeedback(f.admin, {
        id: f.feedback.id,
        status: "implemented",
        implementationNote: "Capture page fixed too.",
      });
      row = await db.feedback.findUniqueOrThrow({
        where: { id: f.feedback.id },
      });
      expect(row.disputeNote).toBe("");
      await verifyFeedback(f.reporter, { id: f.feedback.id, accept: true });
      row = await db.feedback.findUniqueOrThrow({
        where: { id: f.feedback.id },
      });
      expect(row.status).toBe("verified");
      expect(row.verifiedAuto).toBe(false);
      expect(
        await db.notification.count({
          where: { userId: f.admin.uid, kind: "feedback_verified" },
        }),
      ).toBe(1);
      // A verified item can no longer be re-verified or disputed.
      await expect(
        verifyFeedback(f.reporter, { id: f.feedback.id, accept: true }),
      ).rejects.toThrow(/implemented/i);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("auto-verifies untouched implementations after seven days", async () => {
    const f = await fixture();
    try {
      await reviewFeedback(f.admin, {
        id: f.feedback.id,
        status: "implemented",
        implementationNote: "done",
      });
      await db.feedback.update({
        where: { id: f.feedback.id },
        data: { implementedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) },
      });
      // Listing the board settles overdue items.
      await listFeedback(f.admin);
      const row = await db.feedback.findUniqueOrThrow({
        where: { id: f.feedback.id },
      });
      expect(row.status).toBe("verified");
      expect(row.verifiedAuto).toBe(true);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            action: "feedback.auto_verified",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
