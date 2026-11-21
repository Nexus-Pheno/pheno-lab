import { createHash, randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";

function hash(value: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, v[k]]),
            )
          : v,
      ),
    )
    .digest("hex");
}

export async function immutableWrite(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n",
    temp = file + "." + randomUUID();
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  try {
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(file, "utf8")) !== text)
      throw Error("Existing weekly artifact has different bytes");
  } finally {
    await unlink(temp);
  }
}

const metadata = z.object({
  role: z.string(),
  model: z.string(),
  providerHost: z.string(),
  provider: z.string(),
  requestId: z.string().min(1),
  completionId: z.string().min(1),
  inputHash: z.string(),
  evidenceHash: z.string(),
  outputHash: z.string(),
  promptHash: z.string(),
  requestHash: z.string(),
});

export async function checkpoint<
  T extends z.ZodType,
  R extends z.infer<typeof metadata> & { value: z.output<T> },
>(
  file: string,
  role: string,
  system: string,
  payload: { evidence: unknown },
  schema: T,
  execute: () => Promise<R>,
): Promise<R> {
  const policy = hash({
    role,
    system,
    schema: z.toJSONSchema(schema, { unrepresentable: "any" }),
  });
  let result: R;
  let saved = false;
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (raw.checkpointPolicy !== policy)
      throw Error("Weekly checkpoint has a different model contract");
    const { checkpointPolicy: _policy, ...receipt } = raw;
    void _policy;
    result = receipt as R;
    saved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    result = await execute();
  }
  const meta = metadata.parse(result);
  schema.parse(result.value);
  if (
    meta.role !== role ||
    meta.model !== "deepseek-v4-pro" ||
    meta.provider !== "deepseek" ||
    meta.providerHost !== "api.deepseek.com" ||
    meta.inputHash !== hash(payload) ||
    meta.evidenceHash !== hash(payload.evidence) ||
    meta.outputHash !== hash(result.value)
  )
    throw Error(
      "Scientific model checkpoint does not match the frozen request",
    );
  if (!saved)
    await immutableWrite(file, { ...result, checkpointPolicy: policy });
  return result;
}
