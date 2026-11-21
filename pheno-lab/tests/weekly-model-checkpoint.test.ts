import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  checkpoint,
  immutableWrite,
} from "../scripts/weekly-manuscript/checkpoint";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pheno-checkpoint-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("reuses a completed request and blocks changed inputs or output without a second model call", async () => {
  const file = join(dir, "receipt.json");
  const schema = z.strictObject({ label: z.string() });
  const payload = { evidence: { sample: 1 } },
    value = { label: "reviewed" };
  const h = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const call = vi
    .fn()
    .mockResolvedValue({
      value,
      role: "scientist",
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerHost: "api.deepseek.com",
      requestId: "request1",
      completionId: "one",
      inputHash: h(payload),
      evidenceHash: h(payload.evidence),
      outputHash: h(value),
      promptHash: "a",
      requestHash: "b",
    });
  const result = await checkpoint(
    file,
    "scientist",
    "prompt",
    payload,
    schema,
    call,
  );
  expect(
    await checkpoint(file, "scientist", "prompt", payload, schema, call),
  ).toEqual(result);
  await expect(
    checkpoint(
      file,
      "scientist",
      "prompt",
      { evidence: { sample: 2 } },
      schema,
      call,
    ),
  ).rejects.toThrow(/frozen request/i);
  await expect(
    checkpoint(file, "scientist", "new prompt", payload, schema, call),
  ).rejects.toThrow(/different model contract/i);
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.value = { label: "altered" };
  await writeFile(file, JSON.stringify(saved));
  await expect(
    checkpoint(file, "scientist", "prompt", payload, schema, call),
  ).rejects.toThrow(/frozen request/i);
  expect(call).toHaveBeenCalledTimes(1);
});
it("completes repeated identical saves and refuses different bytes", async () => {
  const file = join(dir, "sealed.json");
  await immutableWrite(file, { test: 1 });
  await immutableWrite(file, { test: 1 });
  await expect(immutableWrite(file, { test: 2 })).rejects.toThrow(
    /different bytes/,
  );
});
