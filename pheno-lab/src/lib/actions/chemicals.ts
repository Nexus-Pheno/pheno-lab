"use server";

import { revalidatePath } from "next/cache";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import {
  createChemicalCategory,
  previewChemical,
  saveChemicalRow,
  ChemicalConflictError,
  InvalidSmilesError,
} from "@/modules/chemicals/service";

export async function previewChemicalAction(input: unknown) {
  const actor = await requireSession();
  assertPersonalDevice(actor);
  try {
    return { ok: true as const, value: await previewChemical(actor, input) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof InvalidSmilesError ? "invalidSmiles" : "failed",
    };
  }
}

export async function saveChemicalAction(input: unknown) {
  const actor = await requireSession();
  assertPersonalDevice(actor);
  try {
    const result = await saveChemicalRow(actor, input);
    revalidatePath("/chemicals");
    revalidatePath("/library");
    return { ok: true as const, ...result };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof InvalidSmilesError
          ? "invalidSmiles"
          : error instanceof ChemicalConflictError
            ? "conflict"
            : "failed",
    };
  }
}

export async function createChemicalCategoryAction(input: unknown) {
  const actor = await requireSession();
  assertPersonalDevice(actor);
  try {
    const value = await createChemicalCategory(actor, input);
    revalidatePath("/chemicals");
    revalidatePath("/library");
    return { ok: true as const, value };
  } catch {
    return { ok: false as const, error: "failed" };
  }
}
