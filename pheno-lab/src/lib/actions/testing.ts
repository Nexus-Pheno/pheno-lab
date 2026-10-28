"use server";

import { revalidatePath } from "next/cache";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { requestTesting } from "@/modules/testing/service";
import { revealAccountHandoff } from "@/modules/accounts/provisioning-service";
import { ZodError } from "zod";
import { AuthorizationError } from "@/modules/authorization/policy";
import {
  setTestingStatus,
  TestingStatusConflict,
} from "@/modules/testing/status-service";

export async function notifyTesting(input: unknown) {
  const result = await requestTesting(await requireSession(), input);
  revalidatePath("/testing");
  return result;
}

export async function revealTemporaryLogin(id: string) {
  const session = await requireSession();
  assertPersonalDevice(session);
  return revealAccountHandoff(session, id);
}

export async function updateTestingStatus(input: unknown) {
  const actor = await requireSession("testing");
  let result;
  try {
    result = await setTestingStatus(actor, input);
  } catch (error) {
    if (error instanceof ZodError)
      return { ok: false, error: "invalid" } as const;
    if (error instanceof AuthorizationError)
      return { ok: false, error: "forbidden" } as const;
    if (error instanceof TestingStatusConflict)
      return { ok: false, error: "changed" } as const;
    throw error;
  }
  revalidatePath("/testing");
  revalidatePath(`/testing/${result.experimentId}`);
  return { ok: true } as const;
}
