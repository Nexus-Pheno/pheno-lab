import { db } from "../src/infrastructure/db/client";
import { exportReportEvidence } from "../src/modules/reports/evidence-query";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 100_000) throw new Error("Evidence request is too large.");
    chunks.push(bytes);
  }
  const result = await exportReportEvidence(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  console.log(JSON.stringify(result));
}

main()
  .catch(() => {
    console.error(
      "Read-only report evidence export failed; no credentials or source content are logged.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
