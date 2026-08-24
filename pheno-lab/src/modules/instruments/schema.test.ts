import { describe, expect, it } from "vitest";
import { heartbeatSchema, instrumentUploadMetadataSchema } from "./schema";

describe("instrument boundary schemas", () => {
  it("normalizes valid upload metadata", () => {
    const parsed = instrumentUploadMetadataSchema.parse({
      fileName: "scan.csv",
      modifiedAt: "2026-08-24T10:30:00Z",
    });
    expect(parsed.modifiedAt).toEqual(new Date("2026-08-24T10:30:00Z"));
    expect(parsed.sourcePath).toBe("");
  });

  it("rejects invalid upload timestamps", () => {
    expect(
      instrumentUploadMetadataSchema.safeParse({
        fileName: "scan.csv",
        modifiedAt: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("bounds heartbeat arrays and strings", () => {
    expect(
      heartbeatSchema.safeParse({
        hostname: "rig-1",
        watchDirs: Array.from({ length: 101 }, () => "/data"),
      }).success,
    ).toBe(false);
  });
});
