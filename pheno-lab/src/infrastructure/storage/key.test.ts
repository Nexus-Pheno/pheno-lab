import { describe, expect, it } from "vitest";
import { normalizeObjectKey } from "./key";

describe("normalizeObjectKey", () => {
  it("normalizes Windows separators", () => {
    expect(normalizeObjectKey("instruments\\rig-1\\file.csv")).toBe(
      "instruments/rig-1/file.csv",
    );
  });

  it.each(["", "/absolute", "../secret", "folder/../secret", "folder//file"])(
    "rejects unsafe key %s",
    (key) =>
      expect(() => normalizeObjectKey(key)).toThrow(/Invalid object key/),
  );
});
