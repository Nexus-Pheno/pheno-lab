import { runMorningDigest } from "../src/modules/notifications/digest-service";
import { sweepIdleDrafts } from "../src/modules/experiments/idle-service";
import { recountDataPoints } from "../src/modules/instruments/data-points-service";
import { db } from "../src/infrastructure/db/client";

async function main() {
  try {
    // Housekeeping first, so the digest that follows sees today's state.
    const sweep = await sweepIdleDrafts();
    console.log(
      `Idle drafts: scanned ${sweep.scanned}, warned ${sweep.warned}, archived ${sweep.archived}, reset ${sweep.reset}`,
    );
    const counts = await recountDataPoints();
    console.log(
      `Data points: ${counts.map((c) => `${c.organizationId.slice(-6)}=${c.dataPoints}`).join(", ")}`,
    );
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
