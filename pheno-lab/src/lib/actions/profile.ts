"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireSession, requireAdmin, createSession } from "@/lib/auth";

export async function updateProfile(data: { name: string; handle: string }) {
  const session = await requireSession();
  const name = data.name.trim() || session.name;
  await db.user.update({ where: { id: session.uid }, data: { name, handle: data.handle.trim() } });
  // Refresh the session so the header shows the new name immediately.
  await createSession({ ...session, name });
  revalidatePath("/profile");
}

export async function changePassword(current: string, next: string): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  const user = await db.user.findUniqueOrThrow({ where: { id: session.uid } });
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return { ok: false, error: "wrong-current" };
  }
  if (next.length < 8) return { ok: false, error: "too-short" };
  await db.user.update({
    where: { id: session.uid },
    data: { passwordHash: await bcrypt.hash(next, 10) },
  });
  return { ok: true };
}

export async function setLanguage(lang: "en" | "zh") {
  const session = await requireSession();
  await db.user.update({ where: { id: session.uid }, data: { language: lang } });
  (await cookies()).set("pheno_lang", lang, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  revalidatePath("/", "layout");
}

// ---- Feedback / bug reports ----

export async function submitFeedback(data: {
  kind: "bug" | "feedback";
  message: string;
  screenshotPath: string;
  errorLog: string;
  pageUrl: string;
  userAgent: string;
}) {
  const session = await requireSession();
  if (!data.message.trim()) throw new Error("Message is required.");
  await db.feedback.create({
    data: {
      organizationId: session.org,
      userId: session.uid,
      kind: data.kind,
      message: data.message.trim(),
      screenshotPath: data.screenshotPath,
      errorLog: data.errorLog.slice(0, 8000),
      pageUrl: data.pageUrl.slice(0, 500),
      userAgent: data.userAgent.slice(0, 300),
    },
  });
}

export async function setFeedbackStatus(id: string, status: "open" | "resolved") {
  const session = await requireAdmin();
  await db.feedback.updateMany({ where: { id, organizationId: session.org }, data: { status } });
  revalidatePath("/feedback");
}
