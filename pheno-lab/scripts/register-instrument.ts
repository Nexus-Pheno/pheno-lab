/**
 * Registers a measurement rig and prints its API key ONCE — only the SHA-256 is
 * stored, so copy it straight into the agent's install prompt and do not paste
 * it into chat, tickets or documents.
 *
 *   pnpm exec tsx scripts/register-instrument.ts "小太阳 (GiantForce)" GIANTFORCE_IV
 *   pnpm exec tsx scripts/register-instrument.ts "大太阳 (LIGHTSKY LSS-200)" LIGHTSKY_LIV
 *   pnpm exec tsx scripts/register-instrument.ts --rotate "小太阳 (GiantForce)"
 *   pnpm exec tsx scripts/register-instrument.ts --list
 *
 * An instrument key is a long-lived production credential. Registering one is a
 * production change under ../AGENTS.md and needs the project lead's approval.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../src/lib/instruments/credentials";
// The audit writer is server-only and cannot be imported by a CLI script, so
// the row is written here using the same sanitizer the app uses.
import { sanitizeAuditValue } from "../src/modules/audit/sanitize";

const prisma = new PrismaClient();

function usage(): never {
  console.error(
    "usage:\n" +
      '  register-instrument.ts "<name>" <GIANTFORCE_IV|LIGHTSKY_LIV>\n' +
      '  register-instrument.ts --rotate "<name>"\n' +
      "  register-instrument.ts --list",
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const mode =
    args[0] === "--rotate"
      ? "rotate"
      : args[0] === "--list"
        ? "list"
        : "register";

  const org = await prisma.organization.findFirst({
    where: { orgNumber: 1 },
    select: { id: true, name: true, orgNumber: true },
  });
  if (!org) throw new Error("No organization with orgNumber 1 found.");
  console.log(`\nOrganization: ${org.name} (orgNumber ${org.orgNumber})`);

  if (mode === "list") {
    const rigs = await prisma.instrument.findMany({
      where: { organizationId: org.id },
      select: {
        name: true,
        kind: true,
        active: true,
        apiKeyHint: true,
        hostname: true,
        lastSeenAt: true,
      },
      orderBy: { name: "asc" },
    });
    if (!rigs.length) {
      console.log("\nNo instruments registered yet.\n");
      return;
    }
    console.log("");
    for (const rig of rigs) {
      const seen = rig.lastSeenAt ? rig.lastSeenAt.toISOString() : "never";
      console.log(
        `  ${rig.name}\n    ${rig.kind} · key …${rig.apiKeyHint} · ${
          rig.active ? "active" : "INACTIVE"
        } · host ${rig.hostname || "—"} · last seen ${seen}`,
      );
    }
    console.log("");
    return;
  }

  const name = (mode === "rotate" ? args[1] : args[0])?.trim();
  if (!name) usage();

  const existing = await prisma.instrument.findFirst({
    where: { organizationId: org.id, name },
    select: { id: true, kind: true, apiKeyHint: true, lastSeenAt: true },
  });

  // Rotating silently would break a working agent in the lab with no trace, so
  // overwriting an existing key has to be asked for explicitly.
  if (mode === "register" && existing) {
    throw new Error(
      `"${name}" is already registered (key …${existing.apiKeyHint}, last seen ` +
        `${existing.lastSeenAt ? existing.lastSeenAt.toISOString() : "never"}). ` +
        `Use --rotate to issue a new key, which immediately stops the agent still using the old one.`,
    );
  }
  if (mode === "rotate" && !existing) {
    throw new Error(`No instrument named "${name}" in ${org.name}.`);
  }

  const kind =
    mode === "register" ? (args[1] ?? "").toUpperCase() : existing!.kind;
  if (
    mode === "register" &&
    kind !== "GIANTFORCE_IV" &&
    kind !== "LIGHTSKY_LIV"
  ) {
    throw new Error(
      `kind must be GIANTFORCE_IV or LIGHTSKY_LIV, got "${args[1] ?? ""}"`,
    );
  }

  const key = generateApiKey();
  const credentials = { apiKeyHash: hashApiKey(key), apiKeyHint: key.slice(-4) };

  // The credential change and its audit record land together or not at all.
  await prisma.$transaction(async (transaction) => {
    const instrument = existing
      ? await transaction.instrument.update({
          where: { id: existing.id },
          data: { ...credentials, active: true },
          select: { id: true },
        })
      : await transaction.instrument.create({
          data: {
            ...credentials,
            organizationId: org.id,
            name,
            kind: kind as "GIANTFORCE_IV",
          },
          select: { id: true },
        });

    // "keyHint" rather than "apiKeyHint": the sanitizer redacts any key that
    // looks like an API key, and the last four characters are what makes the
    // audit trail useful.
    const metadata = sanitizeAuditValue({
      name,
      kind,
      keyHint: credentials.apiKeyHint,
      issuedBy: "scripts/register-instrument.ts",
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: org.id,
        actorType: "SYSTEM",
        action: existing ? "instrument.key.rotate" : "instrument.register",
        entityType: "Instrument",
        entityId: instrument.id,
        metadata: metadata === null ? Prisma.JsonNull : metadata,
      },
    });
  });

  console.log(
    existing
      ? `\nRotated the key for "${name}". The agent using the old key will start failing with 401.`
      : `\nRegistered "${name}" (${kind}).`,
  );
  console.log(`\n  API key (shown once):\n\n    ${key}\n`);
  console.log("  Type it straight into the lab PC:  pheno-bridge.exe install");
  console.log("  Do not paste it into chat, tickets, documents or logs.\n");
}

main()
  .catch((error) => {
    console.error("\nERROR:", (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
