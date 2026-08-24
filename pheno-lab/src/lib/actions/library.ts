"use server";

import { revalidatePath } from "next/cache";
import type { ProcessKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { assertSteward } from "@/lib/actions/stewardship";
import type { ParamDef } from "@/lib/library";

// ---- Processes: the overarching library layer ----

export async function createProcess(data: { name: string; kind: ProcessKind; icon: string }) {
  const session = await requireStaff();
  const count = await db.process.count({ where: { organizationId: session.org } });
  await db.process.create({ data: { ...data, organizationId: session.org, position: count } });
  revalidatePath("/library");
}

export async function updateProcess(id: string, data: Partial<{ name: string; icon: string; parameters: ParamDef[]; defaultLayer: string; archived: boolean }>) {
  const session = await requireStaff();
  await db.process.updateMany({ where: { id, organizationId: session.org }, data });
  revalidatePath("/library");
}

// ---- Locations: org presets ----

export async function createLocation(name: string) {
  const session = await assertSteward("facilityAdmin");
  const location = await db.location.create({ data: { organizationId: session.org, name: name.trim() } });
  revalidatePath("/library");
  return location;
}

export async function updateLocation(id: string, data: Partial<{ name: string; archived: boolean }>) {
  const session = await assertSteward("facilityAdmin");
  await db.location.updateMany({ where: { id, organizationId: session.org }, data });
  revalidatePath("/library");
}

// ---- Equipment: belongs to a process, owns its parameters ----

export async function createEquipment(data: {
  processId: string; name: string; make: string; model: string; assetTag: string;
  locationId: string | null; photoPath: string; parameters: ParamDef[];
}) {
  const session = await assertSteward("equipmentAdmin");
  await db.equipment.create({ data: { ...data, organizationId: session.org } });
  revalidatePath("/library");
}

export async function updateEquipment(id: string, data: Partial<{
  processId: string; name: string; make: string; model: string; assetTag: string;
  locationId: string | null; photoPath: string; parameters: ParamDef[]; archived: boolean;
}>) {
  const session = await assertSteward("equipmentAdmin");
  await db.equipment.updateMany({ where: { id, organizationId: session.org }, data });
  revalidatePath("/library");
}

// ---- Environments ----

export async function createEnvironment(data: { name: string; conditions: ParamDef[] }) {
  const session = await assertSteward("facilityAdmin");
  await db.labEnvironment.create({ data: { ...data, organizationId: session.org } });
  revalidatePath("/library");
}

export async function updateEnvironment(id: string, data: Partial<{ name: string; conditions: ParamDef[]; archived: boolean }>) {
  const session = await assertSteward("facilityAdmin");
  await db.labEnvironment.updateMany({ where: { id, organizationId: session.org }, data });
  revalidatePath("/library");
}

// ---- Materials: categorized under a process ----

export async function createMaterial(data: {
  processId: string | null; name: string; composition: string; supplier: string; lot: string;
}) {
  const session = await assertSteward("materialAdmin");
  await db.material.create({ data: { ...data, organizationId: session.org } });
  revalidatePath("/library");
}

export async function updateMaterial(id: string, data: Partial<{
  processId: string | null; name: string; composition: string; supplier: string; lot: string; archived: boolean;
}>) {
  const session = await assertSteward("materialAdmin");
  await db.material.updateMany({ where: { id, organizationId: session.org }, data });
  revalidatePath("/library");
}
