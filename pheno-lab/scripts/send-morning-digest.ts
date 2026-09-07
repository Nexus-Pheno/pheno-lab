import { runMorningDigest } from "../src/modules/notifications/digest-service";
import { db } from "../src/infrastructure/db/client";

async function main() {
  try {
    const status = await runMorningDigest();
    console.log(`DingTalk digest: ${status}`);
    process.exitCode = status === "failed" ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error("DingTalk digest failed.");
  process.exitCode = 1;
});
