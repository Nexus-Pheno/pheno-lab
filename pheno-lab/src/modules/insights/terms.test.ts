import { describe, expect, it } from "vitest";
import { latinPhrases, mergeTerms, terms } from "./terms";

describe("latinPhrases", () => {
  it("lifts a Latin name out of a Chinese sentence", () => {
    expect(
      latinPhrases(
        "只分析First solar相关的实验，当时做的这些实验，那个工艺搭配最好",
      ),
    ).toEqual(["First solar"]);
  });
  it("keeps material-style tokens and drops bare stop words", () => {
    expect(
      latinPhrases(
        "50尺寸基底上，旋涂SAM与刮涂SAM何者更优，与cell4、cell17的搭配",
      ),
    ).toEqual(["SAM", "cell4", "cell17"]);
    expect(latinPhrases("what is the best")).toEqual([]);
  });
});

describe("terms + mergeTerms", () => {
  it("never lets the model drop a phrase that must be searched", () => {
    const must = latinPhrases("First solar打样调试");
    expect(mergeTerms(["工艺搭配", "Cell-4"], must)).toEqual([
      "First solar",
      "工艺搭配",
      "Cell-4",
    ]);
  });
  it("dedupes case-insensitively and caps the list", () => {
    expect(
      mergeTerms(
        ["first solar", "aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"],
        ["First solar"],
      ),
    ).toHaveLength(8);
    expect(terms("Which experiments used Cell-17 on FTO?")).toEqual([
      "Cell-17",
      "FTO",
    ]);
  });
});
