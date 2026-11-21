/** Independently assess one reported mobile scroll boundary using the original and overlapping continuation. */
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeProvider } from "../../src/modules/ai/client";
import { isOfficialDeepSeek } from "../../src/modules/ai/provider-policy";
import { decryptCredential } from "../../src/infrastructure/crypto/credential-server";
import { getWeeklyReportOrganizationId } from "../weekly-report-model";
import { db } from "../../src/infrastructure/db/client";
import {
  answerSchema,
  boundaryEvidence,
  challengeSchema,
  originalBlock,
  stem,
  verifyJudgment,
} from "./vision-boundary-contract";

const sha = (x: Buffer | string) =>
  createHash("sha256").update(x).digest("hex");
async function bounded(path: string, limit: number) {
  if (
    (await realpath(path)) !== path ||
    !(await lstat(path)).isFile() ||
    (await lstat(path)).size > limit
  )
    throw Error("Unexpected visual-review artifact.");
  return readFile(path);
}
async function image(
  root: string,
  entry: { file: string; sha256: string },
  width: number,
) {
  const b = await bounded(join(root, entry.file), 30 * 1024 * 1024);
  if (
    sha(b) !== entry.sha256 ||
    b.length < 24 ||
    !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    b.readUint32BE(16) !== width ||
    b.readUint32BE(20) < 300 ||
    b.readUint32BE(20) > 1600
  )
    throw Error("Viewport review image or dimensions changed.");
  return b;
}
const asImage = (b: Buffer) => ({
  type: "image_url",
  image_url: {
    url: "data:image/png;base64," + b.toString("base64"),
    detail: "original",
  },
});
async function main() {
  const [gateArg, reviewArg, file] = process.argv.slice(2);
  const key = stem(file),
    gate = resolve(gateArg),
    reviews = resolve(reviewArg);
  if (
    (await realpath(gate)) !== gate ||
    (await realpath(reviews)) !== reviews ||
    (await lstat(reviews)).mode & 0o077
  )
    throw Error("Private challenge and review directories required.");
  const challengeBytes = await bounded(
    join(gate, "challenge.json"),
    8 * 1024 * 1024,
  );
  const digest = sha(challengeBytes),
    challenge = challengeSchema.parse(JSON.parse(challengeBytes.toString()));
  const start = challenge.images.findIndex((p) => p.file === file);
  if (start < 0) throw Error("Viewport is absent from challenge.");
  const index = start - (start % 3);
  const files = await readdir(reviews);
  const batchName = files.includes("vision-clarification-" + index + ".json")
    ? "vision-clarification-" + index + ".json"
    : "vision-batch-" + index + ".json";
  const batchRaw = await bounded(join(reviews, batchName), 1024 * 1024);
  const seen = new Set<string>();
  const block = originalBlock(
    JSON.parse(batchRaw.toString()),
    challenge,
    digest,
    file,
    seen,
  );
  const receiptName = "boundary-review-" + key + ".json";
  const receiptPath = join(reviews, receiptName);
  const attemptName = "boundary-attempt-" + key + ".json";
  const attemptPath = join(reviews, attemptName);
  const responsePath = join(reviews, "boundary-response-" + key + ".json");
  const previous = files.includes(attemptName)
    ? (await bounded(attemptPath, 64 * 1024)).toString()
    : undefined;
  for (const name of files.filter(
    (n) =>
      /^(?:vision-(?:batch|clarification)-[0-9]+|boundary-review-(?:en|zh)-(?:320|390)-viewport)\.json$/.test(
        n,
      ) &&
      n !== batchName &&
      n !== receiptName,
  )) {
    const other = JSON.parse(
      (await bounded(join(reviews, name), 1024 * 1024)).toString(),
    );
    seen.add(other.canaryExpected);
    seen.add("id:" + other.responseId);
  }
  const raw = await bounded(
    join(reviews, "boundary-evidence-" + key + ".json"),
    128 * 1024,
  );
  const evidence = boundaryEvidence(
    JSON.parse(raw.toString()),
    challenge,
    digest,
    file,
  );
  const width = Number(key.split("-")[1]);
  const original = await image(gate, evidence.original, width);
  const continuations = await Promise.all(
    [evidence.continuation, ...evidence.horizontalViews].map((i) =>
      image(reviews, i, width),
    ),
  );
  if (
    continuations.some((b) => b.readUint32BE(20) !== original.readUint32BE(20))
  )
    throw Error("Viewport continuation dimensions differ.");
  let token: string;
  if (previous) {
    token = JSON.parse(previous).canaryExpected;
    if (!/^\d{6}$/.test(token) || seen.has(token))
      throw Error("Invalid preserved calibration.");
  } else {
    do {
      token = String(randomInt(1000000)).padStart(6, "0");
    } while (seen.has(token));
  }
  const canary = execFileSync("python3", [
    "-B",
    join(dirname(fileURLToPath(import.meta.url)), "canary.py"),
    token,
  ]);
  const system: unknown = JSON.parse(
    (
      await bounded(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "vision-boundary-prompt.json",
        ),
        16384,
      )
    ).toString(),
  );
  if (typeof system !== "string" || !system.trim())
    throw Error("Missing independent viewport review prompt.");
  const request = JSON.stringify({
    model: "deepseek-flash",
    stream: false,
    max_tokens: 2600,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              finding: block.page.defects,
              observation: block.page.observation,
              order: [
                "calibration",
                "original viewport",
                "overlapping continuation",
                ...evidence.horizontalViews.map(
                  (_, i) => "horizontal continuation " + (i + 1),
                ),
              ],
            }),
          },
          asImage(canary),
          asImage(original),
          ...continuations.map(asImage),
        ],
      },
    ],
  });
  const core = {
    schemaVersion: 1,
    role: "viewport-boundary",
    challengeSha256: digest,
    contentSha256: challenge.contentSha256,
    evidenceSha256: sha(raw),
    originalBatchSha256: sha(batchRaw),
    originalResponseId: block.saved.responseId,
    originalFile: file,
    originalSha256: evidence.original.sha256,
    continuationSha256: evidence.continuation.sha256,
    horizontalViews: evidence.horizontalViews,
    model: "deepseek-flash",
    providerHost: "api.deepseek.com",
    requestHash: sha(request),
    canaryExpected: token,
  };
  // An uncertain completion is not permission for another opinion. Retain the attempt and raw answer.
  let response: string;
  if (previous !== undefined) {
    if (previous !== JSON.stringify(core))
      throw Error(
        "Frozen boundary review input differs from the preserved attempt.",
      );
    response = (await bounded(responsePath, 1024 * 1024)).toString();
  } else {
    const provider = await activeProvider(
      await getWeeklyReportOrganizationId(),
    );
    if (!provider || !isOfficialDeepSeek(provider))
      throw Error("Official visual-review provider unavailable.");
    await writeFile(attemptPath, JSON.stringify(core), {
      flag: "wx",
      mode: 0o600,
    });
    const res = await fetch(
      provider.baseUrl.replace(/\/+$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + decryptCredential(provider.apiKey),
          "Content-Type": "application/json",
        },
        body: request,
        redirect: "error",
        signal: AbortSignal.timeout(240000),
      },
    );
    if (!res.ok) throw Error("Boundary review provider HTTP " + res.status);
    response = await res.text();
    await writeFile(responsePath, response, { flag: "wx", mode: 0o600 });
  }
  const answer = answerSchema.parse(JSON.parse(response));
  const { canary: received, ...result } = verifyJudgment(
    JSON.parse(answer.choices[0].message.content),
    token,
    seen,
    answer.id,
  );
  const receipt = {
    ...core,
    modelReturned: answer.model,
    responseId: answer.id,
    responseHash: sha(response),
    canaryReceived: received,
    completedAt: (await lstat(responsePath)).mtime.toISOString(),
    result,
  };
  if (files.includes(receiptName)) {
    if (
      (await bounded(receiptPath, 128 * 1024)).toString() !==
      JSON.stringify(receipt)
    )
      throw Error(
        "Preserved decision does not match its authentic provider response.",
      );
  } else {
    await writeFile(receiptPath, JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (result.classification !== "NORMAL_VIEWPORT_CONTINUATION")
    throw Error(
      "Independent reviewer found a persistent or unresolved viewport issue.",
    );
}
main()
  .catch((e) => {
    console.error(
      "Boundary review failed.",
      e instanceof Error && e.name !== "ZodError"
        ? e.message
        : "Invalid provider evidence.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
