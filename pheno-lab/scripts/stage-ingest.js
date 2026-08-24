#!/usr/bin/env node
/* Agent intake: stage extracted facts into the app's quality gate.
 *
 * The agent reads the user's files (equipment docs, datasheets, old data),
 * extracts structured facts, and stages them here. Nothing is published —
 * a manager reviews, edits and approves each item at /ingest.
 *
 * Usage:
 *   node scripts/stage-ingest.js '<json>'          # one item or an array
 *   node scripts/stage-ingest.js --file items.json
 *
 * Item shape:
 *   { kind: "MATERIAL" | "EQUIPMENT" | "EXPERIMENT" | "FORMULA",
 *     title: "Hotplate — IKA C-MAG HS 7",
 *     sourceFile: "ika-manual.pdf",
 *     confidence: "parameters read from p.12 table; asset tag guessed",
 *     payload: { ...fields the review form expects... } }
 *
 * MATERIAL payload: name, category (SAM|PRECURSOR|EVAPORATION|SPUTTER|ALD|
 *   SOLVENT|OTHER), composition, smiles, casNumber, molecularWeight, purity,
 *   supplier, lot, properties {k:v}, notes
 * EQUIPMENT payload: name, make, model, assetTag, processName (must match an
 *   existing process), locationName, parameters [{name,unit,defaultValue}], notes
 * FORMULA payload: name, summary (public one-liner), composition, bandGap,
 *   components [{material,amount,role}], solvents, concentration, procedure,
 *   notes. Publishes into the Recipe library (needs recipeAccess); components
 *   are cross-checked against materials but never auto-created.
 * EXPERIMENT payload: anything — reviewed by a human, not auto-created.
 */
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const KINDS = new Set(["MATERIAL", "EQUIPMENT", "EXPERIMENT", "FORMULA", "ENVIRONMENT", "PRESET"]);

(async () => {
  const args = process.argv.slice(2);
  let raw;
  if (args[0] === "--file") raw = fs.readFileSync(args[1], "utf8");
  else raw = args[0];
  if (!raw) {
    console.error("Usage: node scripts/stage-ingest.js '<json>' | --file items.json");
    process.exit(1);
  }

  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const orgSlug = process.env.INGEST_ORG_SLUG || "pheno";
  const org = await db.organization.findFirstOrThrow({ where: { slug: orgSlug } });

  let staged = 0;
  for (const it of items) {
    if (!KINDS.has(it.kind)) throw new Error(`Unknown kind: ${it.kind}`);
    if (!it.title) throw new Error("Each item needs a title.");
    await db.ingestItem.create({
      data: {
        organizationId: org.id,
        kind: it.kind,
        title: it.title,
        sourceFile: it.sourceFile ?? "",
        confidence: it.confidence ?? "",
        payload: it.payload ?? {},
      },
    });
    staged++;
  }
  console.log(`staged ${staged} item(s) for review at /ingest (org: ${org.name})`);
  await db.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
