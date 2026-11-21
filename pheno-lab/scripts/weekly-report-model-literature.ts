import { z } from "zod";

const workRef = z.strictObject({
  id: z.enum(["S1", "S2", "S3"]),
  work: z.string().regex(/^W[0-9]{6,15}$/),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
});
const workSchema = z.object({
  id: z.string(),
  type: z.enum(["article", "journal-article"]),
  is_retracted: z.literal(false),
  is_paratext: z.literal(false),
  title: z.string().min(5).max(600),
  doi: z
    .string()
    .max(350)
    .regex(/^https:\/\/doi\.org\/10\.\d{4,9}\/\S+$/i),
  publication_date: z.iso.date(),
  abstract_inverted_index: z.record(
    z.string().max(800),
    z.array(z.number().int().min(0).max(20000)).max(6000),
  ),
});

function restoreAbstract(index: Record<string, number[]>) {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (words.has(position)) throw new Error("Ambiguous public abstract");
      words.set(position, word);
    }
  }
  const content = Array.from(words)
    .sort(([a], [b]) => a - b)
    .map(([, word]) => word)
    .join(" ");
  if (!content || content.length > 12_000)
    throw new Error(
      "Public abstract unavailable or exceeds research packet budget",
    );
  return content;
}

export async function weeklyPublicLiterature(
  evidence: unknown,
  hash: (value: unknown) => string,
  signal?: AbortSignal,
) {
  const refs =
    z
      .object({ literatureUpdates: z.array(workRef).max(3).optional() })
      .parse(evidence).literatureUpdates ?? [];
  if (
    new Set(refs.map((r) => r.id)).size !== refs.length ||
    new Set(refs.map((r) => r.work)).size !== refs.length
  )
    throw new Error("Duplicate public study");
  const timeout = AbortSignal.timeout(35_000);
  return Promise.all(
    refs.map(async (ref) => {
      // Only public OpenAlex IDs can enter these generic lookups; credentials and Pheno evidence stay out.
      const response = await fetch(
        "https://api.openalex.org/works/" + ref.work,
        {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Public literature identity unavailable");
      }
      const parsed = workSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.id !== "https://openalex.org/" + ref.work
      )
        throw new Error("Public literature metadata rejected");
      const item = parsed.data;
      const record = {
        doi: item.doi,
        title: item.title,
        date: item.publication_date,
        abstract: restoreAbstract(item.abstract_inverted_index),
      };
      if (hash(record) !== ref.sourceHash)
        throw new Error("Public article changed since evidence snapshot");
      return { id: ref.id, ...record };
    }),
  );
}
