import crypto from "node:crypto";

const PREFIX = "enc:v1";

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("AI_CREDENTIAL_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

export function encryptCredentialWithKey(
  plaintext: string,
  encodedKey: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    decodeKey(encodedKey),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptCredentialWithKey(
  encryptedValue: string,
  encodedKey: string,
): string {
  if (!isEncryptedCredential(encryptedValue)) return encryptedValue;
  const [prefix, version, ivText, tagText, ciphertextText] =
    encryptedValue.split(":");
  if (
    `${prefix}:${version}` !== PREFIX ||
    !ivText ||
    !tagText ||
    !ciphertextText
  ) {
    throw new Error("Unsupported encrypted credential format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    decodeKey(encodedKey),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
