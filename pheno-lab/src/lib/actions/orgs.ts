"use server";

import { requireSession } from "@/lib/auth";
import {
  approveOrganization as approveOrganizationService,
  checkInvite as checkInviteService,
  createOrgInvite as createOrgInviteService,
  isPlatformAdmin as isPlatformAdminService,
  rejectOrganization as rejectOrganizationService,
  renameOwnOrganization as renameOwnOrganizationService,
  saveOrgDomains as saveOrgDomainsService,
  submitOrganization as submitOrganizationService,
} from "@/modules/organizations/service";

export async function isPlatformAdmin(): Promise<boolean> {
  return isPlatformAdminService(await requireSession());
}

export async function createOrgInvite(): Promise<{ token: string }> {
  return createOrgInviteService(await requireSession());
}

export async function approveOrganization(orgId: string) {
  await approveOrganizationService(await requireSession(), orgId);
}

export async function rejectOrganization(orgId: string) {
  await rejectOrganizationService(await requireSession(), orgId);
}

export async function saveOrgDomains(orgId: string, domainsCsv: string) {
  await saveOrgDomainsService(await requireSession(), orgId, domainsCsv);
}

export async function renameOwnOrganization(name: string) {
  await renameOwnOrganizationService(await requireSession(), name);
}

export async function checkInvite(token: string): Promise<{ valid: boolean }> {
  return checkInviteService(token);
}

export async function submitOrganization(data: {
  token: string;
  orgName: string;
  domainsCsv: string;
  adminName: string;
  adminEmail: string;
  password: string;
}) {
  return submitOrganizationService(data);
}
