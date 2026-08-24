/**
 * Gives every existing experiment a short handle and every sample its
 * instrument serial. Safe to re-run: handles already assigned are left alone,
 * and hand-added aliases are preserved.
 *
 *   pnpm exec tsx scripts/backfill-serials.ts
 */
import { PrismaClient } from "@prisma/client";
import { serialsFor, shortCodeFor } from "../src/lib/instruments/serial";

const prisma = new PrismaClient();

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, nextShortNo: true } });

  for (const org of orgs) {
    const experiments = await prisma.experiment.findMany({
      where: { organizationId: org.id },
      select: { id: true, code: true, shortCode: true, samples: { select: { id: true, code: true, instrumentCodes: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!experiments.length) continue;

    let next = org.nextShortNo;
    console.log(`\n${org.name}: ${experiments.length} experiment(s)`);

    for (const exp of experiments) {
      let shortCode = exp.shortCode;
      if (!shortCode) {
        shortCode = shortCodeFor(next++);
        await prisma.experiment.update({ where: { id: exp.id }, data: { shortCode } });
      }
      let touched = 0;
      for (const s of exp.samples) {
        const primary = serialsFor(shortCode, s.code)[0];
        const aliases = s.instrumentCodes.filter((c) => c !== primary);
        const codes = serialsFor(shortCode, s.code, aliases);
        const same = codes.length === s.instrumentCodes.length && codes.every((c, i) => c === s.instrumentCodes[i]);
        if (!same) {
          await prisma.sample.update({ where: { id: s.id }, data: { instrumentCodes: codes } });
          touched++;
        }
      }
      console.log(`  ${exp.code.padEnd(16)} → ${shortCode.padEnd(5)} ${exp.samples.length} sample(s), ${touched} updated`);
    }
    await prisma.organization.update({ where: { id: org.id }, data: { nextShortNo: next } });
  }
  console.log("\nDone.\n");
}

main()
  .catch((e) => {
    console.error("\nERROR:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
