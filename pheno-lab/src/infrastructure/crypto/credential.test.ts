import { describe, expect, it } from "vitest";
import {
  decryptCredentialWithKey,
  encryptCredentialWithKey,
  isEncryptedCredential,
} from "./credential";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const otherKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

describe("credential encryption", () => {
  it("round-trips with authenticated encryption", () => {
    const encrypted = encryptCredentialWithKey("sk-private", key);
    expect(isEncryptedCredential(encrypted)).toBe(true);
    expect(encrypted).not.toContain("sk-private");
    expect(decryptCredentialWithKey(encrypted, key)).toBe("sk-private");
  });

  it("rejects the wrong key", () => {
    const encrypted = encryptCredentialWithKey("sk-private", key);
    expect(() => decryptCredentialWithKey(encrypted, otherKey)).toThrow();
  });

  it("allows a one-time legacy plaintext migration read", () => {
    expect(decryptCredentialWithKey("legacy-plaintext", key)).toBe(
      "legacy-plaintext",
    );
  });
});
