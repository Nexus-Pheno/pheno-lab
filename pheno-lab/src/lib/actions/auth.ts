"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession } from "@/lib/auth";
import { authenticate } from "@/modules/accounts/auth-service";

export async function login(
  _prev: { error?: string } | null,
  formData: FormData,
) {
  const result = await authenticate({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!result) return { error: "Invalid email or password." };
  await createSession(result.actor);
  (await cookies()).set("pheno_lang", result.language, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
