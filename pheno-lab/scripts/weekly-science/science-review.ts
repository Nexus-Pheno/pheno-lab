import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { db } from "../../src/infrastructure/db/client";
import {
  callWeeklyFinalReview,
  getWeeklyReportOrganizationId,
} from "../weekly-report-model";

async function main() {
  const [gateArg, reviewArg] = process.argv.slice(2);
  if (!gateArg || !reviewArg || process.argv.length !== 4)
    throw Error("Expected gate and reviews directories");
  process.umask(0o077);
  const gate = resolve(gateArg);
  const reviews = resolve(reviewArg);
  const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const raw = await readFile(join(gate, "challenge.json"));
  const challenge = JSON.parse(raw.toString());
  const data = await readFile(join(gate, "final-science-input.json"));
  if (challenge.outputs["final-science-input.json"] !== hash(data))
    throw Error("Final review evidence changed");
  const packet = JSON.parse(data.toString());
  if (
    challenge.challenge !== packet.challenge ||
    challenge.contentSha256 !== packet.contentSha256
  )
    throw Error("Final review challenge changed");
  await mkdir(reviews, { mode: 0o700, recursive: true });
  const info = await stat(reviews);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw Error("Private review directory required");
  const result = await callWeeklyFinalReview({
    orgId: await getWeeklyReportOrganizationId(),
    payload: packet,
  });
  const receipt = {
    ...result,
    schemaVersion: 1,
    role: "final-scientific",
    challenge: challenge.challenge,
    challengeSha256: hash(raw),
    contentSha256: challenge.contentSha256,
    completedAt: new Date().toISOString(),
  };
  await writeFile(
    join(reviews, "scientific-review.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  if (result.value.decision !== "PASS")
    throw Error("Referee requested revisions or held the paper");
}
main()
  .catch(() => {
    console.error(
      "Final scientific review incomplete or requires correction. Inspect private receipts.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
