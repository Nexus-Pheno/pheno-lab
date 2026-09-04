"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createSession, requireSession } from "@/lib/auth";
import {
  changePassword as changePasswordService,
  reviewFeedback as reviewFeedbackService,
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
  title?: string;
  message: string;
  screenshotPath?: string;
  photoFileNames?: string[];
  errorLog?: string;
  pageUrl?: string;
  userAgent?: string;
}) {
  await submitFeedbackService(await requireSession(), data);
  revalidatePath("/feedback");
}

export async function reviewFeedback(
  id: string,
  patch: {
    status?: "open" | "approved" | "rejected" | "implemented";
    adminNote?: string;
    title?: string;
    message?: string;
  },
) {
  await reviewFeedbackService(await requireSession(), { id, ...patch });
  revalidatePath("/feedback");
}
