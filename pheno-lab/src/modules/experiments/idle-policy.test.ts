import { describe, expect, it } from "vitest";
import { idleDecision } from "./idle-policy";

const day = 24 * 3_600_000;
const now = new Date("2026-09-16T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * day);

describe("idleDecision", () => {
  it("leaves a draft alone under 7 idle days", () => {
    expect(
      idleDecision({ now, lastActivityAt: ago(6.9), warnedAt: null }),
    ).toBe("none");
  });

  it("warns once at 7 idle days", () => {
    expect(idleDecision({ now, lastActivityAt: ago(7), warnedAt: null })).toBe(
      "warn",
    );
    // Already warned: not again, and not yet archived.
    expect(
      idleDecision({ now, lastActivityAt: ago(8), warnedAt: ago(1) }),
    ).toBe("none");
  });

  it("archives at 10 idle days, but only 3 days after the warning", () => {
    expect(
      idleDecision({ now, lastActivityAt: ago(10), warnedAt: ago(3) }),
    ).toBe("archive");
    // Old draft first seen today: warned now, so it gets its 3 days.
    expect(idleDecision({ now, lastActivityAt: ago(30), warnedAt: null })).toBe(
      "warn",
    );
    expect(
      idleDecision({ now, lastActivityAt: ago(30), warnedAt: ago(2) }),
    ).toBe("none");
    expect(
      idleDecision({ now, lastActivityAt: ago(30), warnedAt: ago(3) }),
    ).toBe("archive");
  });

  it("clears the warning when the draft is touched again", () => {
    expect(
      idleDecision({ now, lastActivityAt: ago(0.5), warnedAt: ago(1) }),
    ).toBe("reset");
  });
});
