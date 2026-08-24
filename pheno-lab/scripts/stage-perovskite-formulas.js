#!/usr/bin/env node
/* Stage the formulas from 钙钛矿配方.xlsx into the ingestion quality gate.
 *
 * Source: Pheno Data/钙钛矿配方.xlsx
 *   sheet 大面积模组配方  — 9 formulas laid out as side-by-side column blocks
 *   sheet 小面积配方      — 1 small-area formula
 *   sheet 钙钛矿带隙      — composition + band gap per formula name
 *
 * Component amounts and units are transcribed exactly as written; where the
 * sheet omits a unit the assumption is recorded in the item's confidence note
 * so the reviewer can confirm it rather than discover it later.
 *
 * Nothing is published — everything lands as PENDING at /ingest.
 *
 * Usage: node scripts/stage-perovskite-formulas.js [--dry]
 */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const SRC = "钙钛矿配方.xlsx";

// mg unless written otherwise in the sheet.
const c = (material, amount, role) => ({ material, amount, role: role || "" });

const FORMULAS = [
  {
    name: "稳定性配方 (Stability formula)",
    summary: "Cs0.05(FA0.95MA0.05)0.95Pb(I0.95Br0.05)3 — 1.58 eV, large-area module",
    composition: "Cs0.05(FA0.95MA0.05)0.95Pb(I0.95Br0.05)3",
    bandGap: "1.58 eV",
    concentration: "",
    solvents: "DMF 910 µL : NMP 90 µL",
    components: [
      c("PbI2", "541.46 mg", "B-site"),
      c("CsI", "15.59 mg", "A-site"),
      c("PbBr2", "22.57 mg", "B-site / halide"),
      c("FAI", "186.24 mg", "A-site"),
      c("MACl", "12.15 mg", "additive"),
      c("MABr", "6.38 mg", "A-site / halide"),
      c("DMF", "910 µL", "solvent"),
      c("NMP", "90 µL", "solvent"),
    ],
    procedure: "Per 1 mL of precursor solution (sheet header 成分 / 1ml).",
    notes: "Sheet block A/B of 大面积模组配方.",
    confidence:
      "Solid amounts in the sheet are bare numbers with no unit — read as mg, consistent with the other blocks. The sheet writes 'MACI' (capital i); transcribed as MACl. Please confirm both.",
  },
  {
    name: "高效配方 (High-efficiency formula)",
    summary: "Cs0.10FA0.90Pb(I0.985Br0.015)3 — 1.55 eV, large-area module",
    composition: "Cs0.10FA0.90Pb(I0.985Br0.015)3",
    bandGap: "1.55 eV",
    concentration: "",
    solvents: "DMF 900 µL : NMP 100 µL",
    components: [
      c("MEO", "0.3 mg/mL", "additive"),
      c("MACl", "16.2 mg", "additive"),
      c("CsI", "26.5 mg", "A-site"),
      c("FAI", "185.7 mg", "A-site"),
      c("PbI2", "569.8 mg", "B-site"),
      c("CsBr", "3.83 mg", "A-site / halide"),
      c("PbBr2", "6.61 mg", "B-site / halide"),
      c("DMF", "900 µL", "solvent"),
      c("NMP", "100 µL", "solvent"),
    ],
    procedure: "Per 1 mL of precursor solution (sheet header 成分 / 1mL).",
    notes: "Sheet block D/E of 大面积模组配方. Named 高效率配方 on the band-gap sheet.",
    confidence:
      "MEO unit confirmed as mg/mL by Michael (2026-08-20) — the sheet itself gives only the bare number 0.3. What 'MEO' IS remains open: no library material matches that abbreviation. 2-methoxyethanol is in the library but is a solvent, an odd fit at 0.3 mg/mL — set the component to the correct material name before publishing. Other solid amounts read as mg.",
  },
  {
    name: "室内光伏配方 (Indoor PV formula)",
    summary: "Cs0.05FA0.70MA0.25Pb(I0.75Br0.25)3 — 1.70 eV, indoor photovoltaics",
    composition: "Cs0.05FA0.70MA0.25Pb(I0.75Br0.25)3",
    bandGap: "1.70 eV",
    concentration: "",
    solvents: "DMF 900 µL : NMP 100 µL",
    components: [
      c("CsI", "19.49 mg", "A-site"),
      c("FAI", "180.57 mg", "A-site"),
      c("MABr", "41.97 mg", "A-site / halide"),
      c("PbBr2", "137.62 mg", "B-site / halide"),
      c("PbI2", "560.12 mg", "B-site"),
      c("尿素 (Urea)", "2 mg", "additive"),
      c("F-PEAI", "0.8 mg", "additive / passivation"),
      c("亚甲基二氨基二盐酸盐 (MDACl2)", "1.2 mg", "additive"),
      c("PbSCN", "4.83 mg", "additive"),
      c("油胺碘 (OAmI)", "0.85 mg", "additive / passivation"),
      c("DMF", "900 µL", "solvent"),
      c("NMP", "100 µL", "solvent"),
    ],
    procedure: "Per 1 mL of precursor solution (sheet header 成分 / 1ml).",
    notes: "Sheet block G/H of 大面积模组配方. Five additives here are new to the materials library.",
    confidence:
      "Solid amounts are bare numbers, read as mg. 'PbSCN' is written without stoichiometry — lead thiocyanate is normally Pb(SCN)2; staged as a new material under that name. MDACl is staged as the dichloride (MDACl2), the usual perovskite additive.",
  },
  {
    name: "配方 Cs0.05FA0.95PbI3",
    summary: "Cs0.05FA0.95PbI3 — 1.53 eV, 1.3 M",
    composition: "Cs0.05FA0.95PbI3",
    bandGap: "1.53 eV",
    concentration: "1.3 M",
    solvents: "DMF 900 µL : NMP 100 µL",
    components: [
      c("FAI", "212.3 mg", "A-site"),
      c("PbI2", "617.3 mg", "B-site"),
      c("MACl", "8.8 mg", "additive"),
      c("CsI", "16.9 mg", "A-site"),
      c("DMF", "900 µL", "solvent"),
      c("NMP", "100 µL", "solvent"),
    ],
    procedure: "",
    notes: "Sheet block J/K of 大面积模组配方.",
    confidence: "Amounts and concentration read directly from the sheet; units explicit.",
  },
  {
    name: "配方 Cs0.05MA0.1FA0.85PbI3",
    summary: "Cs0.05MA0.1FA0.85PbI3 — 1.50 eV, 1.3 M",
    composition: "Cs0.05MA0.1FA0.85PbI3",
    bandGap: "1.50 eV",
    concentration: "1.3 M",
    solvents: "DMF 1130 µL : NMP 125 µL",
    components: [
      c("FAI", "237.6 mg", "A-site"),
      c("PbI2", "830 mg", "B-site"),
      c("MACl", "15 mg", "additive"),
      c("CsI", "21.2 mg", "A-site"),
      c("MAI", "25.8 mg", "A-site"),
      c("DMF", "1130 µL", "solvent"),
      c("NMP", "125 µL", "solvent"),
    ],
    procedure: "",
    notes: "Sheet block M/N of 大面积模组配方.",
    confidence:
      "NOTE — the solid amounts here are identical to 小面积配方3 (MACl 15 / CsI 21.2 / MAI 25.8 / FAI 237.6 / PbI2 830). Only the solvent differs (DMF:NMP here vs DMF:DMSO 4:1 there) and the band gap is listed as 1.50 vs 1.52 eV. Please decide whether these are genuinely two formulas or one recorded twice.",
  },
  {
    name: "配方 FA0.83Cs0.17PbI3",
    summary: "FA0.83Cs0.17PbI3 — 1.57 eV, 1.3 M",
    composition: "FA0.83Cs0.17PbI3",
    bandGap: "1.57 eV",
    concentration: "1.3 M",
    solvents: "DMF 2000 µL : NMP 249.6 µL",
    components: [
      c("FAI", "371.28 mg", "A-site"),
      c("CsI", "114.92 mg", "A-site"),
      c("PbI2", "1198.6 mg", "B-site"),
      c("PbCl2", "108.42 mg", "additive / halide"),
      c("NMP", "249.6 µL", "solvent"),
      c("DMF", "2000 µL", "solvent"),
    ],
    procedure: "",
    notes: "Sheet block P/Q of 大面积模组配方.",
    confidence: "Amounts explicit in the sheet. Batch is ~2 mL rather than 1 mL — scale noted from the solvent volumes.",
  },
  {
    name: "HFZ配方 FA0.88Cs0.12PbI3",
    summary: "FA0.88Cs0.12PbI3 — 1.55 eV, 1.3 M",
    composition: "FA0.88Cs0.12PbI3",
    bandGap: "1.55 eV",
    concentration: "1.3 M",
    solvents: "DMF 8000 µL : NMP 844.8 µL",
    components: [
      c("FAI", "1332.32 mg", "A-site"),
      c("CsI", "274.56 mg", "A-site"),
      c("PbI2", "4259.2 mg", "B-site"),
      c("MACl", "178.64 mg", "additive"),
      c("NMP", "844.8 µL", "solvent"),
      c("DMF", "8000 µL", "solvent"),
    ],
    procedure: "",
    notes: "Sheet block S/T of 大面积模组配方. Large batch (~8 mL).",
    confidence: "Amounts explicit in the sheet.",
  },
  {
    name: "宽带隙配方 (Wide-gap formula)",
    summary: "Cs0.15FA0.85Pb(I0.77Br0.23)3 — 1.68 eV, tandem top cell",
    composition: "Cs0.15FA0.85Pb(I0.77Br0.23)3",
    bandGap: "1.68 eV",
    concentration: "",
    solvents: "DMF 900 µL : NMP 100 µL",
    components: [
      c("MACl", "2.64 mg", "additive"),
      c("PbCl2", "10.86 mg", "additive / halide"),
      c("CsI", "74.3 mg", "A-site"),
      c("FAI", "173.35 mg", "A-site"),
      c("PbBr2", "121.67 mg", "B-site / halide"),
      c("PbI2", "446.48 mg", "B-site"),
      c("DMF", "900 µL", "solvent"),
      c("NMP", "100 µL", "solvent"),
    ],
    procedure: "",
    notes: "Sheet block V/W of 大面积模组配方.",
    confidence:
      "This block has no header row, so components start immediately — no concentration is stated for it. Compare with the existing library recipe 'Wide-gap 1.68 eV (tandem top cell)', which is a different composition (Cs0.22FA0.78Pb(I0.85Br0.15)3).",
  },
  {
    name: "配方6",
    summary: "Cs0.05MA0.05FA0.9Pb(I0.95Br0.05)3 — 1.55 eV",
    composition: "Cs0.05MA0.05FA0.9Pb(I0.95Br0.05)3",
    bandGap: "1.55 eV",
    concentration: "",
    solvents: "",
    components: [
      c("PbI2", "586.57 mg", "B-site"),
      c("CsI", "16.9 mg", "A-site"),
      c("PbBr2", "24.45 mg", "B-site / halide"),
      c("FAI", "201.76 mg", "A-site"),
      c("MACl", "8.8 mg", "additive"),
      c("MABr", "6.9 mg", "A-site / halide"),
    ],
    procedure: "",
    notes: "Sheet block Y/Z of 大面积模组配方.",
    confidence:
      "NO SOLVENT is listed for this formula in the sheet — the solvent field is deliberately left empty rather than guessed. The band-gap sheet writes the composition with a full-width bracket 'Pb（I0.95Br0.05)3'; normalised to ASCII here.",
  },
  {
    name: "小面积配方3 (Small-area formula 3)",
    summary: "Cs0.05MA0.10FA0.85PbI3 — 1.52 eV, small-area cells",
    composition: "Cs0.05MA0.10FA0.85PbI3",
    bandGap: "1.52 eV",
    concentration: "",
    solvents: "DMF:DMSO = 4:1 (DMF 800 µL : DMSO 200 µL)",
    components: [
      c("MACl", "15 mg", "additive"),
      c("CsI", "21.2 mg", "A-site"),
      c("MAI", "25.8 mg", "A-site"),
      c("FAI", "237.6 mg", "A-site"),
      c("PbI2", "830 mg", "B-site"),
      c("DMF", "800 µL", "solvent"),
      c("DMSO", "200 µL", "solvent"),
    ],
    procedure: "Solvent system DMF:DMSO = 4:1.",
    notes: "Sheet 小面积配方 (titled 钙钛矿溶液小面积配方3).",
    confidence:
      "NOTE — same solid amounts as 配方 Cs0.05MA0.1FA0.85PbI3 (block M/N); only the solvent system differs. Please decide whether these are two formulas or one recorded twice.",
  },
];

// Components the materials library does not have yet. Chemistry verified
// against PubChem; the confidence note records what was looked up and what
// was derived, so nothing is taken on trust.
const MATERIALS = [
  {
    name: "尿素 (Urea)",
    category: "ADDITIVE",
    composition: "CH4N2O",
    smiles: "C(=O)(N)N",
    casNumber: "57-13-6",
    molecularWeight: "60.06",
    properties: { "Role in perovskite": "Crystallisation modifier / Lewis base additive", "Source": "PubChem CID 1176" },
    notes: "Used at 2 mg/mL in 室内光伏配方.",
    confidence: "Formula, weight and structure from PubChem (CID 1176). CAS 57-13-6 is the standard registry number for urea.",
  },
  {
    name: "PbSCN (lead(II) thiocyanate)",
    category: "ADDITIVE",
    composition: "Pb(SCN)2",
    smiles: "C(#N)[S-].C(#N)[S-].[Pb+2]",
    casNumber: "592-87-0",
    molecularWeight: "323.36",
    properties: { "Role in perovskite": "Grain-growth / defect passivation additive", "Source": "PubChem — lead(2+) dithiocyanate" },
    notes: "Written as 'PbSCN' in 室内光伏配方 (4.83 mg/mL); the compound is the dithiocyanate Pb(SCN)2.",
    confidence:
      "Formula C2N2PbS2, weight 323 and structure from PubChem; CAS 592-87-0 from its synonym list. The sheet's 'PbSCN' is missing the subscript — confirm the intended reagent is Pb(SCN)2.",
  },
  {
    name: "F-PEAI (4-fluorophenethylammonium iodide)",
    category: "ADDITIVE",
    composition: "C8H11FIN",
    smiles: "[NH3+]CCc1ccc(F)cc1.[I-]",
    casNumber: "1413269-55-2",
    molecularWeight: "267.08",
    properties: { "Role in perovskite": "2D surface passivation (fluorinated PEAI)", "Free base": "2-(4-fluorophenyl)ethanamine, C8H10FN, 139.17" },
    notes: "Used at 0.8 mg/mL in 室内光伏配方. Related to the library's existing PEAI (phenethylammonium iodide).",
    confidence:
      "Free base verified on PubChem (C8H10FN, 139.17, SMILES C1=CC(=CC=C1CCN)F); the ammonium-iodide salt SMILES and MW 267.08 are derived from it (+HI). CAS 1413269-55-2 from Greatcell Solar Materials, not PubChem — worth a second check.",
  },
  {
    name: "MDACl2 (methylenediammonium dichloride)",
    category: "ADDITIVE",
    composition: "CH8Cl2N2",
    smiles: "C(N)N.Cl.Cl",
    casNumber: "57166-92-4",
    molecularWeight: "118.99",
    properties: { "Role in perovskite": "α-FAPbI3 phase stabiliser", "Chinese name": "亚甲基二氨基二盐酸盐" },
    notes: "Used at 1.2 mg/mL in 室内光伏配方. Sheet writes 'MDACl'; the standard additive is the dichloride MDACl2.",
    confidence:
      "Formula CH8Cl2N2, weight 118.99, structure and CAS 57166-92-4 all from PubChem (methanediamine;dihydrochloride). Confirm the sheet's 'MDACl' means the dichloride.",
  },
  {
    name: "OAmI (oleylammonium iodide)",
    category: "ADDITIVE",
    composition: "C18H38IN",
    smiles: "CCCCCCCC/C=C\\CCCCCCCC[NH3+].[I-]",
    casNumber: "1802520-56-4",
    molecularWeight: "395.41",
    properties: { "Role in perovskite": "Long-chain surface passivation", "Chinese name": "油胺碘", "Free base": "Oleylamine, C18H37N, 267.5" },
    notes: "Used at 0.85 mg/mL in 室内光伏配方.",
    confidence:
      "Free base oleylamine verified on PubChem (C18H37N, 267.5, (Z)-octadec-9-en-1-amine); salt SMILES and MW 395.41 derived from it (+HI). CAS 1802520-56-4 from supplier catalogues, not PubChem — worth a second check.",
  },
];

(async () => {
  const dry = process.argv.includes("--dry");
  const orgSlug = process.env.INGEST_ORG_SLUG || "pheno";
  const org = await db.organization.findFirstOrThrow({ where: { slug: orgSlug } });

  const items = [];
  for (const m of MATERIALS) {
    const { confidence, ...payload } = m;
    items.push({
      kind: "MATERIAL",
      title: m.name,
      sourceFile: `${SRC} → 大面积模组配方 (new component)`,
      confidence,
      payload: { ...payload, purity: "", supplier: "", lot: "" },
    });
  }
  for (const f of FORMULAS) {
    const { confidence, ...payload } = f;
    items.push({
      kind: "FORMULA",
      title: f.name,
      sourceFile: SRC,
      confidence,
      payload,
    });
  }

  if (dry) {
    console.log(JSON.stringify(items, null, 2));
    console.log(`\n${items.length} item(s) would be staged.`);
    await db.$disconnect();
    return;
  }

  let staged = 0;
  for (const it of items) {
    await db.ingestItem.create({
      data: {
        organizationId: org.id,
        kind: it.kind,
        title: it.title,
        sourceFile: it.sourceFile,
        confidence: it.confidence,
        payload: it.payload,
      },
    });
    staged++;
  }
  console.log(`staged ${staged} item(s) for review at /ingest (org: ${org.name})`);
  console.log(`  ${MATERIALS.length} materials, ${FORMULAS.length} formulas`);
  await db.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
