"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, destroySession } from "@/lib/auth";

export async function login(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    return { error: "Invalid email or password." };
  }
  await createSession({ uid: user.id, name: user.name, role: user.role, org: user.organizationId });
  (await cookies()).set("pheno_lang", user.language === "zh" ? "zh" : "en", {
    path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax",
  });
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
