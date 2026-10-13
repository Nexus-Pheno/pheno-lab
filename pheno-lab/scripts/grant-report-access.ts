import { grantReportAccess } from "../src/modules/reports/service";
import { db } from "../src/infrastructure/db/client";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 10_000) throw new Error("Input too large.");
    chunks.push(bytes);
  }
  console.log(
    JSON.stringify(
      await grantReportAccess(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      ),
    ),
  );
}

main()
  .catch(() => {
    console.error(
      "Report access provisioning failed. Verify approved identities and audited state; no confidential input is logged.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
