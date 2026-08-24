"use server";

import type { ProcessKind } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import type { ParamDef } from "@/lib/library";
import {
  createEnvironment as createEnvironmentService,
  createEquipment as createEquipmentService,
  createLibraryMaterial,
  createLocation as createLocationService,
  createProcess as createProcessService,
  updateEnvironment as updateEnvironmentService,
  updateEquipment as updateEquipmentService,
  updateLibraryMaterial,
  updateLocation as updateLocationService,
  updateProcess as updateProcessService,
} from "@/modules/library/service";

const refresh = () => revalidatePath("/library");

export async function createProcess(data: {
  name: string;
  kind: ProcessKind;
  icon: string;
}) {
  await createProcessService(await requireSession(), data);
  refresh();
}

export async function updateProcess(
  id: string,
  data: Partial<{
    name: string;
    icon: string;
    parameters: ParamDef[];
    defaultLayer: string;
    archived: boolean;
  }>,
) {
  await updateProcessService(await requireSession(), { id, data });
  refresh();
}

export async function createLocation(name: string) {
  const row = await createLocationService(await requireSession(), { name });
  refresh();
  return row;
}

export async function updateLocation(
  id: string,
  data: Partial<{ name: string; archived: boolean }>,
) {
  await updateLocationService(await requireSession(), { id, data });
  refresh();
}

export async function createEquipment(data: {
  processId: string;
  name: string;
  make: string;
  model: string;
  assetTag: string;
  locationId: string | null;
  photoPath: string;
  parameters: ParamDef[];
}) {
  await createEquipmentService(await requireSession(), data);
  refresh();
}

export async function updateEquipment(
  id: string,
  data: Partial<{
    processId: string;
    name: string;
    make: string;
    model: string;
    assetTag: string;
    locationId: string | null;
    photoPath: string;
    parameters: ParamDef[];
    archived: boolean;
  }>,
) {
  await updateEquipmentService(await requireSession(), { id, data });
  refresh();
}

export async function createEnvironment(data: {
  name: string;
  conditions: ParamDef[];
}) {
  await createEnvironmentService(await requireSession(), data);
  refresh();
}

export async function updateEnvironment(
  id: string,
  data: Partial<{
    name: string;
    conditions: ParamDef[];
    archived: boolean;
  }>,
) {
  await updateEnvironmentService(await requireSession(), { id, data });
  refresh();
}

export async function createMaterial(data: {
  processId: string | null;
  name: string;
  composition: string;
  supplier: string;
  lot: string;
}) {
  await createLibraryMaterial(await requireSession(), data);
  refresh();
}

export async function updateMaterial(
  id: string,
  data: Partial<{
    processId: string | null;
    name: string;
    composition: string;
    supplier: string;
    lot: string;
    archived: boolean;
  }>,
) {
  await updateLibraryMaterial(await requireSession(), { id, data });
  refresh();
}
