"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

// Which surface the user wants: the full dashboard (desktop) or the mobile
// input portal. Stored in a cookie so the choice sticks per device.
export type ViewMode = "desktop" | "portal";

export async function setViewMode(mode: ViewMode) {
  (await cookies()).set("pheno_view", mode, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  redirect(mode === "portal" ? "/portal" : "/");
}

/** Resolve the preferred surface: explicit cookie wins; otherwise sniff the
 * device — phones and tablets default to the input portal. */
export async function preferredView(): Promise<ViewMode> {
  const cookie = (await cookies()).get("pheno_view")?.value;
  if (cookie === "portal" || cookie === "desktop") return cookie;
  const ua = (await headers()).get("user-agent") ?? "";
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua) ? "portal" : "desktop";
}
