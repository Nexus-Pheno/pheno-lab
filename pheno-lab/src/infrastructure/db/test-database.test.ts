import { describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./test-database";

const safe = "postgresql://tester:tester@127.0.0.1:5432/pheno_lab_test";

describe("assertSafeTestDatabaseUrl", () => {
  it("accepts an isolated loopback test database", () => {
    expect(
      assertSafeTestDatabaseUrl({
        testDatabaseUrl: safe,
        primaryDatabaseUrl:
          "postgresql://developer:developer@127.0.0.1:5432/pheno_lab",
      }).pathname,
    ).toBe("/pheno_lab_test");
  });

  it("rejects a database without the _test suffix", () => {
    expect(() =>
      assertSafeTestDatabaseUrl({
        testDatabaseUrl: "postgresql://tester:tester@127.0.0.1:5432/pheno_lab",
      }),
    ).toThrow(/_test/);
  });

  it("rejects the primary database", () => {
    expect(() =>
      assertSafeTestDatabaseUrl({
        testDatabaseUrl: safe,
        primaryDatabaseUrl: safe,
      }),
    ).toThrow(/must not equal/);
  });

  it("rejects remote databases outside CI", () => {
    expect(() =>
      assertSafeTestDatabaseUrl({
        testDatabaseUrl:
          "postgresql://tester:tester@db.internal:5432/pheno_lab_test",
      }),
    ).toThrow(/loopback/);
  });

  it("allows a CI service hostname", () => {
    expect(
      assertSafeTestDatabaseUrl({
        testDatabaseUrl:
          "postgresql://tester:tester@postgres:5432/pheno_lab_test",
        ci: true,
      }).hostname,
    ).toBe("postgres");
  });
});
