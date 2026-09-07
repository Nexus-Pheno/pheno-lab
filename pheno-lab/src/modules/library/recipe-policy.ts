import type { Actor } from "@/modules/authorization/actor";

export function canReadRecipeContents(
  actor: Actor,
  recipe: {
    organizationId: string;
    createdById: string | null;
    approvalStatus: string;
  },
  grants: { recipeAccess: boolean; recipeSteward: boolean },
): boolean {
  return (
    recipe.organizationId === actor.org &&
    (actor.role === "ADMIN" ||
      grants.recipeSteward ||
      recipe.createdById === actor.uid ||
      (recipe.approvalStatus === "APPROVED" && grants.recipeAccess))
  );
}
