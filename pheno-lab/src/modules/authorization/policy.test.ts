import { describe, expect, it } from "vitest";
import type { Actor, ExperimentAccessResource } from "./actor";
import {
  assertAdmin,
  assertExperimentPermission,
  assertStaff,
  canCaptureExperiment,
  canManageExperiment,
  canReadExperiment,
  canSubmitExperiment,
} from "./policy";

const resource: ExperimentAccessResource = {
  organizationId: "org-a",
  createdById: "manager-owner",
  assigneeId: "technician-assignee",
  members: [{ userId: "manager-member" }, { userId: "technician-member" }],
};

const actor = (uid: string, role: Actor["role"], org = "org-a"): Actor => ({
  uid,
  role,
  org,
});

describe("authorization policy", () => {
  it("keeps admin and staff role checks centralized", () => {
    expect(() => assertAdmin(actor("admin", "ADMIN"))).not.toThrow();
    expect(() => assertAdmin(actor("manager", "MANAGER"))).toThrow();
    expect(() => assertStaff(actor("manager", "MANAGER"))).not.toThrow();
    expect(() => assertStaff(actor("tech", "TECHNICIAN"))).toThrow();
  });

  it("implements the experiment read matrix", () => {
    // Managers and admins open everything; technicians open what they
    // created, are assigned to, or joined (Michael's 2026-09-07 model).
    expect(canReadExperiment(actor("admin", "ADMIN"), resource)).toBe(true);
    expect(canReadExperiment(actor("manager-other", "MANAGER"), resource)).toBe(
      true,
    );
    expect(
      canReadExperiment(actor("technician-member", "TECHNICIAN"), resource),
    ).toBe(true);
    expect(
      canReadExperiment(actor("technician-other", "TECHNICIAN"), resource),
    ).toBe(false);
  });

  it("lets managers edit everything and technicians edit their own or assigned", () => {
    expect(canManageExperiment(actor("admin", "ADMIN"), resource)).toBe(true);
    expect(
      canManageExperiment(actor("manager-other", "MANAGER"), resource),
    ).toBe(true);
    // The creator manages their own experiment regardless of role.
    expect(
      canManageExperiment(actor("manager-owner", "TECHNICIAN"), resource),
    ).toBe(true);
    // The assigned technician holds the pen too (Michael, 2026-09-08).
    expect(
      canManageExperiment(actor("technician-assignee", "TECHNICIAN"), resource),
    ).toBe(true);
    // Granted membership means collaborate, not redesign.
    expect(
      canManageExperiment(actor("technician-member", "TECHNICIAN"), resource),
    ).toBe(false);
    expect(
      canManageExperiment(actor("technician-other", "TECHNICIAN"), resource),
    ).toBe(false);
  });

  it("preserves the technician capture exception", () => {
    expect(
      canCaptureExperiment(actor("technician-member", "TECHNICIAN"), resource),
    ).toBe(true);
    expect(
      canCaptureExperiment(actor("technician-other", "TECHNICIAN"), resource),
    ).toBe(false);
    expect(
      canCaptureExperiment(actor("manager-other", "MANAGER"), resource),
    ).toBe(true);
  });

  it("allows an assignee to submit", () => {
    expect(
      canSubmitExperiment(actor("technician-assignee", "TECHNICIAN"), resource),
    ).toBe(true);
    expect(
      canSubmitExperiment(actor("technician-member", "TECHNICIAN"), resource),
    ).toBe(true);
  });

  it("denies every permission across organizations", () => {
    const outsider = actor("admin", "ADMIN", "org-b");
    for (const permission of ["read", "manage", "capture", "submit"] as const) {
      expect(() =>
        assertExperimentPermission(outsider, resource, permission),
      ).toThrow(/another organization/);
    }
  });
});
