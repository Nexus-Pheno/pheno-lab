"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  createUserAccount as createUserAccountService,
  requestRegistration as requestRegistrationService,
  setEmailDomains as setEmailDomainsService,
  setUserActive as setUserActiveService,
  setUserRole as setUserRoleService,
  updateUserIdentity as updateUserIdentityService,
  approveRegistration as approveRegistrationService,
  rejectRegistration as rejectRegistrationService,
  verifyRegistration as verifyRegistrationService,
} from "@/modules/accounts/registration-service";

export async function requestRegistration(email: string) {
  return requestRegistrationService(email);
}

export async function verifyRegistration(data: {
  email: string;
  code: string;
  name: string;
  password: string;
}) {
  return verifyRegistrationService(data);
}

export async function createUserAccount(data: {
  name: string;
  email: string;
  password: string;
  role: "ADMIN" | "MANAGER" | "TECHNICIAN";
}) {
  return createUserAccountService(data, await requireSession());
}

export async function setUserRole(
  userId: string,
  role: "ADMIN" | "MANAGER" | "TECHNICIAN",
) {
  await setUserRoleService(await requireSession(), userId, role);
}

export async function approveRegistration(data: {
  userId: string;
  name: string;
  handle: string;
  email: string;
  legacyUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await approveRegistrationService(await requireSession(), data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function rejectRegistration(userId: string): Promise<void> {
  await rejectRegistrationService(await requireSession(), userId);
}

export async function updateUserIdentity(
  userId: string,
  name: string,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await updateUserIdentityService(await requireSession(), userId, {
      name,
      email,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function setUserActive(userId: string, active: boolean) {
  await setUserActiveService(
    await requireSession(),
    userId,
    z.boolean().parse(active),
  );
}

export async function setEmailDomains(domainsCsv: string) {
  await setEmailDomainsService(
    await requireSession(),
    z.string().max(5_000).parse(domainsCsv),
  );
}
