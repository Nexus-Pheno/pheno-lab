import { publishLabReport } from "../src/modules/reports/service";
import { db } from "../src/infrastructure/db/client";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 3_000_000) throw new Error("Publication input is too large.");
    chunks.push(bytes);
  }
  const result = await publishLabReport(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error(
      "Report publication failed; no credentials or content are logged. Check input and audited state before retrying.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
