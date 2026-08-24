import "server-only";

import crypto from "node:crypto";
import { serverConfig } from "@/infrastructure/config/server";
import { rematchAllOrganizations } from "./measurement-rematch-service";

export function authorizeRematch(
  token: string,
): "ok" | "unconfigured" | "denied" {
  const secret = serverConfig().INGEST_CRON_SECRET;
  if (!secret) return "unconfigured";
  const provided = Buffer.from(token.trim());
  const expected = Buffer.from(secret);
  return provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
    ? "ok"
    : "denied";
}

export async function rematchEveryOrganization() {
  return rematchAllOrganizations();
}
