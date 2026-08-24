/**
 * Registers a measurement rig and prints its API key ONCE — only the hash is
 * stored, so copy it straight into the agent's install prompt.
 *
 *   pnpm exec tsx scripts/register-instrument.ts "小太阳" GIANTFORCE_IV
 *   pnpm exec tsx scripts/register-instrument.ts "大太阳" LIGHTSKY_LIV
 *   pnpm exec tsx scripts/register-instrument.ts --rotate "小太阳"
 */
import { PrismaClient } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../src/lib/instruments/credentials";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const rotate = args[0] === "--rotate";
  const [name, kindRaw] = rotate ? [args[1], ""] : args;
  if (!name) {
    console.error('usage: register-instrument.ts "<name>" <GIANTFORCE_IV|LIGHTSKY_LIV>   |   --rotate "<name>"');
    process.exit(2);
  }

  const org = await prisma.organization.findFirst({ where: { orgNumber: 1 }, select: { id: true, name: true } });
  if (!org) throw new Error("No organization with orgNumber 1 found.");

  const key = generateApiKey();
  const data = { apiKeyHash: hashApiKey(key), apiKeyHint: key.slice(-4) };

  if (rotate) {
    const existing = await prisma.instrument.findFirst({ where: { organizationId: org.id, name } });
    if (!existing) throw new Error(`No instrument named "${name}" in ${org.name}.`);
    await prisma.instrument.update({ where: { id: existing.id }, data });
    console.log(`\nRotated the key for "${name}".`);
  } else {
    const kind = (kindRaw ?? "").toUpperCase();
    if (kind !== "GIANTFORCE_IV" && kind !== "LIGHTSKY_LIV") {
      throw new Error(`kind must be GIANTFORCE_IV or LIGHTSKY_LIV, got "${kindRaw}"`);
    }
    await prisma.instrument.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      update: { ...data, kind, active: true },
      create: { ...data, organizationId: org.id, name, kind },
    });
    console.log(`\nRegistered "${name}" (${kind}) for ${org.name}.`);
  }

  console.log(`\n  API key (shown once):\n\n    ${key}\n`);
  console.log("  Use it on the lab PC:  pheno-bridge.exe install\n");
}

main()
  .catch((e) => {
    console.error("\nERROR:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
