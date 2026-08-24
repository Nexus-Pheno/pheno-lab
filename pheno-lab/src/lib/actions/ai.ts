"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import {
  deleteAiProvider as deleteAiProviderService,
  fetchAvailableModels as fetchAvailableModelsService,
  hasActiveAiProvider as hasActiveAiProviderService,
  listAiProviders as listAiProvidersService,
  saveAiProvider as saveAiProviderService,
  setActiveAiProvider as setActiveAiProviderService,
  testAiProvider as testAiProviderService,
  type AiProviderRow,
} from "@/modules/ai/service";

export type { AiProviderRow };

export async function listAiProviders(): Promise<AiProviderRow[]> {
  return listAiProvidersService(await requireSession());
}

export async function saveAiProvider(data: {
  id?: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}) {
  await saveAiProviderService(await requireSession(), data);
  revalidatePath("/profile");
}

export async function setActiveAiProvider(id: string) {
  await setActiveAiProviderService(await requireSession(), id);
  revalidatePath("/profile");
}

export async function deleteAiProvider(id: string) {
  await deleteAiProviderService(await requireSession(), id);
  revalidatePath("/profile");
}

export async function testAiProvider(id: string): Promise<string> {
  const status = await testAiProviderService(await requireSession(), id);
  revalidatePath("/profile");
  return status;
}

export async function hasActiveAiProvider(): Promise<boolean> {
  return hasActiveAiProviderService(await requireSession());
}

export async function fetchAvailableModels(input: {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return fetchAvailableModelsService(await requireSession(), input);
}
