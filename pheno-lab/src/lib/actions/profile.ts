"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createSession, requireSession } from "@/lib/auth";
import {
  changePassword as changePasswordService,
  setFeedbackStatus as setFeedbackStatusService,
  setLanguage as setLanguageService,
  submitFeedback as submitFeedbackService,
  updateProfile as updateProfileService,
} from "@/modules/accounts/profile-service";

export async function updateProfile(data: { name: string; handle: string }) {
  const session = await requireSession();
  const profile = await updateProfileService(session, data);
  await createSession({ ...session, name: profile.name });
  revalidatePath("/profile");
}

export async function changePassword(current: string, next: string) {
  return changePasswordService(await requireSession(), { current, next });
}

export async function setLanguage(lang: "en" | "zh") {
  const language = await setLanguageService(await requireSession(), lang);
  (await cookies()).set("pheno_lang", language, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}

export async function submitFeedback(data: {
  kind: "bug" | "feedback";
  message: string;
  screenshotPath: string;
  errorLog: string;
  pageUrl: string;
  userAgent: string;
}) {
  await submitFeedbackService(await requireSession(), data);
}

export async function setFeedbackStatus(
  id: string,
  status: "open" | "resolved",
) {
  await setFeedbackStatusService(await requireSession(), { id, status });
  revalidatePath("/feedback");
}
