import { describe, expect, it } from "vitest";
import { loginSchema, registrationSchema } from "./schema";

describe("account boundary schemas", () => {
  it("normalizes login email", () => {
    expect(
      loginSchema.parse({ email: " User@Example.COM ", password: "secret" })
        .email,
    ).toBe("user@example.com");
  });

  it("bounds passwords before bcrypt", () => {
    expect(
      loginSchema.safeParse({
        email: "user@example.com",
        password: "x".repeat(129),
      }).success,
    ).toBe(false);
  });

  it("requires a six-digit OTP and a non-trivial password", () => {
    expect(
      registrationSchema.safeParse({
        email: "user@example.com",
        code: "123",
        name: "User",
        password: "short",
      }).success,
    ).toBe(false);
  });
});
