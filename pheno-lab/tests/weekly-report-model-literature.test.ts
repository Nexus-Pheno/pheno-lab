import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { weeklyPublicLiterature } from "../scripts/weekly-report-model-literature";
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value as object).sort()))
    .digest("hex");
const literature = {
  doi: "https://doi.org/10.1000/example",
  title: "Synthetic public study",
  date: "2000-01-01",
  abstract: "A synthetic study.",
};
const work = {
  id: "https://openalex.org/W123456789",
  type: "article",
  is_retracted: false,
  is_paratext: false,
  title: literature.title,
  doi: literature.doi,
  publication_date: literature.date,
  abstract_inverted_index: { "study.": [2], A: [0], synthetic: [1] },
};
const ref = { id: "S1", work: "W123456789", sourceHash: hash(literature) };
afterEach(() => vi.unstubAllGlobals());
test("fetches only a hashed public work, sorted by word position, independent of private evidence", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(work));
  vi.stubGlobal("fetch", fetch);
  const articles = await weeklyPublicLiterature(
    { literatureUpdates: [ref], privateId: "never-send" },
    hash,
  );
  expect(articles).toEqual([{ id: "S1", ...literature }]);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.openalex.org/works/W123456789",
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  expect(JSON.stringify(fetch.mock.calls)).not.toMatch(
    /never-send|authorization/i,
  );
});
test("rejects a replacement, withdrawn or changed primary source and ambiguous abstract", async () => {
  for (const substitute of [
    { ...work, id: "https://openalex.org/W999999" },
    { ...work, is_retracted: true },
    { ...work, type: "review" },
    { ...work, title: "Different public paper" },
    { ...work, abstract_inverted_index: { incomplete: [1], ambiguous: [1] } },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(substitute)),
    );
    await expect(
      weeklyPublicLiterature({ literatureUpdates: [ref] }, hash),
    ).rejects.toThrow();
  }
});
test("never queries a caller-controlled URL and prevents duplicate paper references", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    weeklyPublicLiterature(
      { literatureUpdates: [{ ...ref, work: "https://example.test/secret" }] },
      hash,
    ),
  ).rejects.toThrow();
  await expect(
    weeklyPublicLiterature({ literatureUpdates: [ref, ref] }, hash),
  ).rejects.toThrow("Duplicate");
  expect(fetch).not.toHaveBeenCalled();
});
