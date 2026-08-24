"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  createUserAccount as createUserAccountService,
  requestRegistration as requestRegistrationService,
  setEmailDomains as setEmailDomainsService,
  setUserActive as setUserActiveService,
  setUserRole as setUserRoleService,
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
