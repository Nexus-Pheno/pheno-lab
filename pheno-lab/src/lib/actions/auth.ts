"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession, getDevice } from "@/lib/auth";
import {
  authenticate,
  authenticateById,
} from "@/modules/accounts/auth-service";

export async function login(
  _prev: { error?: string } | null,
  formData: FormData,
) {
  // The tap-a-name path: the tile submits a user id instead of an email.
  // Only registered shared tablets may use it — anywhere else the id form
  // field is simply ignored and the email path applies.
  const userId = formData.get("userId");
  let result = null;
  if (typeof userId === "string" && userId) {
    const device = await getDevice();
    if (device) {
      result = await authenticateById({
        userId,
        password: formData.get("password"),
        organizationId: device.organizationId,
      });
    }
  } else {
    result = await authenticate({
      email: formData.get("email"),
      password: formData.get("password"),
    });
  }
  if (result && "pending" in result) return { error: "pending" };
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
