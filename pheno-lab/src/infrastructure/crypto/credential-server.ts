import "server-only";

import { serverConfig } from "@/infrastructure/config/server";
import {
  decryptCredentialWithKey,
  encryptCredentialWithKey,
} from "./credential";

function credentialKey(): string {
  const key = serverConfig().AI_CREDENTIAL_KEY;
  if (!key)
    throw new Error(
      "AI credentials are unavailable until AI_CREDENTIAL_KEY is configured",
    );
  return key;
}

export function encryptCredential(plaintext: string): string {
  return encryptCredentialWithKey(plaintext, credentialKey());
}

export function decryptCredential(value: string): string {
  return decryptCredentialWithKey(value, credentialKey());
}
