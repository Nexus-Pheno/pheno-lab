import { describe, expect, it } from "vitest";
import {
  matchOperatorToUser,
  normalizeOperatorName,
  type MatchableUser,
} from "./operator-match";

const user = (id: string, name: string, active = true): MatchableUser => ({
  id,
  name,
  active,
});

const lab = [
  user("u-david", "David"),
  user("u-river", "River"),
  user("u-jiantao", "Jiantao Wang"),
];

describe("normalizeOperatorName", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalizeOperatorName("  Jiantao  Wang ")).toBe("jiantaowang");
    expect(normalizeOperatorName("O'Brien-Smith")).toBe("obriensmith");
  });
});

describe("matchOperatorToUser", () => {
  it("matches an exact name regardless of case and spacing", () => {
    expect(matchOperatorToUser("david", lab)?.id).toBe("u-david");
    expect(matchOperatorToUser(" Jiantao Wang ", lab)?.id).toBe("u-jiantao");
  });

  it("matches a single-character typo", () => {
    expect(matchOperatorToUser("Davidd", lab)?.id).toBe("u-david"); // insertion
    expect(matchOperatorToUser("Davi", lab)?.id).toBe("u-david"); // deletion
    expect(matchOperatorToUser("Davld", lab)?.id).toBe("u-david"); // substitution
  });

  it("refuses to guess when two accounts are equally close", () => {
    // "Dan" is one insertion away from BOTH "Dana" and "Dane" — picking either
    // would hand one person's measurements to the other.
    const ambiguous = [user("u-dana", "Dana"), user("u-dane", "Dane")];
    expect(matchOperatorToUser("Dan", ambiguous)).toBeNull();
    // The same typed name still resolves when only one account is close.
    expect(matchOperatorToUser("Dan", [user("u-dana", "Dana")])?.id).toBe(
      "u-dana",
    );
  });

  it("refuses a two-character difference", () => {
    expect(matchOperatorToUser("Davidxy", lab)).toBeNull();
  });

  it("never matches a deactivated account", () => {
    // Imported historical operators are inactive placeholders and must not
    // become owners of live instrument data.
    const imported = [user("u-old", "Rose", false)];
    expect(matchOperatorToUser("Rose", imported)).toBeNull();
  });

  it("returns null for a blank operator, which is how the LIGHTSKY rig arrives", () => {
    expect(matchOperatorToUser("", lab)).toBeNull();
    expect(matchOperatorToUser("   ", lab)).toBeNull();
  });

  it("returns null for an unknown name", () => {
    expect(matchOperatorToUser("Nobody", lab)).toBeNull();
  });

  it("does not pick one of two identically named accounts", () => {
    const twins = [user("u-a", "Chris"), user("u-b", "chris")];
    expect(matchOperatorToUser("Chris", twins)).toBeNull();
  });
});
