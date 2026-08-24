import { describe, expect, it } from "vitest";
import { sanitizeAuditValue } from "./sanitize";

describe("sanitizeAuditValue", () => {
  it("removes secrets recursively", () => {
    expect(
      sanitizeAuditValue({
        title: "experiment",
        apiKey: "must-not-leak",
        nested: { sessionToken: "must-not-leak", count: 2 },
      }),
    ).toEqual({ title: "experiment", nested: { count: 2 } });
  });

  it("bounds strings and arrays", () => {
    const result = sanitizeAuditValue({
      text: "x".repeat(700),
      rows: Array.from({ length: 120 }, (_, index) => index),
    }) as { text: string; rows: number[] };
    expect(result.text).toHaveLength(500);
    expect(result.rows).toHaveLength(100);
  });
});
