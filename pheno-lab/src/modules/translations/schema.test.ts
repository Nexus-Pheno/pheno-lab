import { describe, expect, it } from "vitest";
import { counterpart, detectLang, sourceHash, translatable } from "./schema";

describe("detectLang", () => {
  it("detects Chinese by CJK presence", () => {
    expect(detectLang("对比不同浓度的GBAC")).toBe("zh");
    expect(detectLang("退火 30 min at 100C")).toBe("zh");
  });
  it("defaults to English", () => {
    expect(detectLang("Annealed 30 min, film looks uniform")).toBe("en");
  });
});

describe("counterpart", () => {
  it("maps each language to the other", () => {
    expect(counterpart("zh")).toBe("en");
    expect(counterpart("en")).toBe("zh");
  });
});

describe("translatable", () => {
  it("rejects empty and numeric-only strings", () => {
    expect(translatable("")).toBe(false);
    expect(translatable("  ")).toBe(false);
    expect(translatable("1.23")).toBe(false);
    expect(translatable("100, 200; 300%")).toBe(false);
  });
  it("accepts real sentences in either language", () => {
    expect(translatable("薄膜均匀")).toBe(true);
    expect(translatable("Film is uniform")).toBe(true);
  });
});

describe("sourceHash", () => {
  it("ignores surrounding whitespace", () => {
    expect(sourceHash(" 薄膜均匀 ")).toBe(sourceHash("薄膜均匀"));
  });
});
