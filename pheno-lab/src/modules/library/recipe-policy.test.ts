import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/authorization/actor";
import { canReadRecipeContents } from "./recipe-policy";

describe("recipe visibility", () => {
  const actor: Actor = { uid: "reader", org: "home", role: "TECHNICIAN" };
  const recipe = {
    organizationId: "home",
    createdById: "owner",
    approvalStatus: "PENDING",
  };
  const none = { recipeAccess: false, recipeSteward: false };
  it("never crosses organizations, even for admins and creators", () => {
    expect(
      canReadRecipeContents(
        { ...actor, uid: "owner", role: "ADMIN" },
        { ...recipe, organizationId: "foreign" },
        { recipeAccess: true, recipeSteward: true },
      ),
    ).toBe(false);
  });
  it.each(["PENDING", "APPROVED", "REJECTED"])(
    "allows the creator and stewards: %s",
    (approvalStatus) => {
      expect(
        canReadRecipeContents(
          { ...actor, uid: "owner" },
          { ...recipe, approvalStatus },
          none,
        ),
      ).toBe(true);
      expect(
        canReadRecipeContents(
          actor,
          { ...recipe, approvalStatus },
          { ...none, recipeSteward: true },
        ),
      ).toBe(true);
    },
  );
  it.each(["PENDING", "REJECTED"])(
    "recipeAccess cannot reveal unapproved contents: %s",
    (approvalStatus) => {
      expect(
        canReadRecipeContents(
          actor,
          { ...recipe, approvalStatus },
          { ...none, recipeAccess: true },
        ),
      ).toBe(false);
    },
  );
  it("requires recipeAccess for another user's approved contents", () => {
    expect(
      canReadRecipeContents(
        actor,
        { ...recipe, approvalStatus: "APPROVED" },
        none,
      ),
    ).toBe(false);
    expect(
      canReadRecipeContents(
        actor,
        { ...recipe, approvalStatus: "APPROVED" },
        { ...none, recipeAccess: true },
      ),
    ).toBe(true);
  });
});
