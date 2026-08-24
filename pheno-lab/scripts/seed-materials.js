/* One-off: prefill the materials library (wiki cards) and sample recipes
 * for org #1. Idempotent — skips materials/recipes that already exist by
 * name. Values are typical reference data; the material administrator
 * maintains vendor/batch per delivery. Run: node scripts/seed-materials.js */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const M = (name, category, composition, casNumber, molecularWeight, properties, notes = "") => ({
  name, category, composition, casNumber, molecularWeight, properties, notes,
});

const MATERIALS = [
  // ---- Wet-process SAM materials ----
  M("Me-4PACz", "SAM", "C18H22NO3P — [4-(3,6-dimethyl-9H-carbazol-9-yl)butyl]phosphonic acid", "2761610-58-2", "331.35",
    { "HOMO (eV)": "-5.72", "LUMO (eV)": "≈ -2.1", "Solubility": "Ethanol / IPA (0.3–1 mg/mL)", "Function": "Hole-selective SAM on ITO / NiOx", "Storage": "Inert, dark, RT" },
    "Workhorse SAM for inverted (p-i-n) cells; excellent wide-gap performance."),
  M("2PACz", "SAM", "C14H14NO3P — [2-(9H-carbazol-9-yl)ethyl]phosphonic acid", "20999-38-6", "275.24",
    { "HOMO (eV)": "-5.71", "Solubility": "Ethanol / IPA", "Function": "Hole-selective SAM", "Storage": "Inert, dark, RT" },
    "Baseline carbazole phosphonic-acid SAM; deeper HOMO than MeO-2PACz."),
  M("MeO-2PACz", "SAM", "C16H18NO5P — [2-(3,6-dimethoxy-9H-carbazol-9-yl)ethyl]phosphonic acid", "2359616-64-1", "335.29",
    { "HOMO (eV)": "-5.37", "Solubility": "Ethanol / IPA", "Function": "Hole-selective SAM", "Storage": "Inert, dark, RT" },
    "Shallower HOMO — good for narrow-gap / Sn-Pb absorbers."),
  // ---- Wet-process perovskite precursors ----
  M("FAI (formamidinium iodide)", "PRECURSOR", "CH5N2I", "879643-71-7", "171.97",
    { "Appearance": "White crystalline powder", "Purity (typ.)": "≥99.99%", "Storage": "Dry, <10 °C, inert" },
    "A-site cation source; hygroscopic — weigh in glovebox."),
  M("MAI (methylammonium iodide)", "PRECURSOR", "CH6NI", "14965-49-2", "158.97",
    { "Appearance": "White powder", "Purity (typ.)": "≥99.9%", "Storage": "Dry, dark, inert" }),
  M("MABr (methylammonium bromide)", "PRECURSOR", "CH6NBr", "6876-37-5", "111.97",
    { "Appearance": "White powder", "Storage": "Dry, dark, inert" }),
  M("MACl (methylammonium chloride)", "PRECURSOR", "CH6NCl", "593-51-1", "67.52",
    { "Function": "Crystallization additive (volatile)", "Storage": "Dry, inert" },
    "Common additive (~0.3–0.5 molar eq.) — improves grain growth; leaves film on anneal."),
  M("CsI (cesium iodide)", "PRECURSOR", "CsI", "7789-17-5", "259.81",
    { "Purity (typ.)": "99.999%", "Storage": "Dry", "Note": "Often added from 1.5 M DMSO stock" }),
  M("CsBr (cesium bromide)", "PRECURSOR", "CsBr", "7787-69-1", "212.81",
    { "Purity (typ.)": "99.999%", "Storage": "Dry" }),
  M("PbI2 (lead iodide)", "PRECURSOR", "PbI2", "10101-63-0", "461.01",
    { "Purity (typ.)": "99.99% (trace-metal)", "Appearance": "Yellow powder", "Hazard": "Toxic — Pb", "Storage": "Dry, dark" }),
  M("PbBr2 (lead bromide)", "PRECURSOR", "PbBr2", "10031-22-8", "367.01",
    { "Purity (typ.)": "99.99%", "Hazard": "Toxic — Pb", "Storage": "Dry" }),
  M("PbCl2 (lead chloride)", "PRECURSOR", "PbCl2", "7758-95-4", "278.11",
    { "Purity (typ.)": "99.99%", "Hazard": "Toxic — Pb", "Storage": "Dry" }),
  M("RbI (rubidium iodide)", "PRECURSOR", "RbI", "7790-29-6", "212.37",
    { "Purity (typ.)": "99.9%", "Storage": "Dry" }),
  M("SnI2 (tin(II) iodide)", "PRECURSOR", "SnI2", "10294-70-9", "372.52",
    { "Purity (typ.)": "99.99%", "Hazard": "Oxidizes readily (Sn2+→Sn4+)", "Storage": "Glovebox only" },
    "For narrow-gap Sn-Pb absorbers; pair with SnF2 additive."),
  // ---- Thermal evaporation materials ----
  M("C60 (fullerene)", "EVAPORATION", "C60", "99685-96-8", "720.64",
    { "Purity (typ.)": "99.9% (sublimed)", "Function": "Electron transport layer", "Evap. temp": "≈400–450 °C", "LUMO (eV)": "≈ -4.0" }),
  M("BCP (bathocuproine)", "EVAPORATION", "C26H20N2", "4733-39-5", "360.45",
    { "Purity (typ.)": "≥99.5% (sublimed)", "Function": "Buffer / hole-blocking layer (~6–8 nm)", "Evap. temp": "≈150–170 °C" }),
  M("Au (gold)", "EVAPORATION", "Au", "7440-57-5", "196.97",
    { "Purity (typ.)": "99.999%", "Function": "Top electrode (~80–100 nm)", "Work function (eV)": "≈5.1" }),
  M("Ag (silver)", "EVAPORATION", "Ag", "7440-22-4", "107.87",
    { "Purity (typ.)": "99.99%", "Function": "Top electrode", "Work function (eV)": "≈4.3", "Note": "Halide corrosion risk — use with buffer" }),
  M("Cu (copper, evaporation)", "EVAPORATION", "Cu", "7440-50-8", "63.55",
    { "Purity (typ.)": "99.999%", "Function": "Low-cost top electrode", "Work function (eV)": "≈4.65" }),
  M("MoO3 (molybdenum trioxide)", "EVAPORATION", "MoO3", "1313-27-5", "143.94",
    { "Function": "Hole-injection buffer", "Evap. temp": "≈500 °C" }),
  M("LiF (lithium fluoride)", "EVAPORATION", "LiF", "7789-24-4", "25.94",
    { "Function": "Interlayer (~1 nm)", "Purity (typ.)": "99.99%" }),
  // ---- Sputter materials ----
  M("ITO target (In2O3:SnO2 90:10)", "SPUTTER", "In2O3:SnO2 90:10 wt%", "50926-11-9", "—",
    { "Function": "Transparent electrode", "Sheet resistance (typ.)": "10–15 Ω/sq @ 100 nm", "Work function (eV)": "≈4.7", "Note": "Soft-landing/buffer needed over C60" }),
  M("IZO target (In2O3:ZnO 90:10)", "SPUTTER", "In2O3:ZnO 90:10 wt%", "", "—",
    { "Function": "Amorphous transparent electrode", "Note": "Better flexibility than ITO, no crystallization anneal" }),
  M("AZO target (ZnO:Al2O3 98:2)", "SPUTTER", "ZnO:Al2O3 98:2 wt%", "", "—",
    { "Function": "Indium-free transparent electrode / buffer" }),
  M("NiOx target", "SPUTTER", "NiO (non-stoichiometric)", "1313-99-1", "74.69",
    { "Function": "Inorganic hole transport layer", "Note": "Pair with SAM for best Voc" }),
  M("Cu target (sputter)", "SPUTTER", "Cu", "7440-50-8", "63.55",
    { "Purity (typ.)": "99.999%", "Function": "Metal electrode / grid" }),
  // ---- ALD materials ----
  M("TDMASn (for ALD SnO2)", "ALD", "C8H24N4Sn — tetrakis(dimethylamino)tin(IV)", "1066-77-9", "295.01",
    { "Deposits": "SnO2 (ETL / buffer)", "ALD window": "80–120 °C (with H2O)", "Hazard": "Moisture-sensitive", "Storage": "Sealed bubbler" },
    "Standard precursor for ALD SnO2 sputter-buffer in tandems."),
  M("TMA (for ALD Al2O3)", "ALD", "C3H9Al — trimethylaluminum", "75-24-1", "72.09",
    { "Deposits": "Al2O3 (passivation / encapsulation)", "ALD window": "80–200 °C (with H2O)", "Hazard": "PYROPHORIC" }),
  M("TDMAT (for ALD TiO2)", "ALD", "C8H24N4Ti — tetrakis(dimethylamino)titanium", "3275-24-9", "224.19",
    { "Deposits": "TiO2 (compact ETL)", "ALD window": "100–200 °C", "Hazard": "Moisture-sensitive" }),
  // ---- Solvents ----
  M("DMF (N,N-dimethylformamide)", "SOLVENT", "C3H7NO", "68-12-2", "73.09",
    { "Boiling point": "153 °C", "Grade": "Anhydrous 99.8%", "Hazard": "Reprotoxic — glovebox/fume hood", "Role": "Primary perovskite solvent" }),
  M("DMSO (dimethyl sulfoxide)", "SOLVENT", "C2H6OS", "67-68-5", "78.13",
    { "Boiling point": "189 °C", "Grade": "Anhydrous 99.9%", "Role": "Coordinating co-solvent (adduct former)" }),
  M("NMP (N-methyl-2-pyrrolidone)", "SOLVENT", "C5H9NO", "872-50-4", "99.13",
    { "Boiling point": "202 °C", "Role": "Co-solvent for blade/slot-die inks" }),
  M("2-Methoxyethanol", "SOLVENT", "C3H8O2", "109-86-4", "76.09",
    { "Boiling point": "124 °C", "Role": "Fast-drying solvent for scalable coating", "Hazard": "Reprotoxic" }),
  M("Ethanol (anhydrous)", "SOLVENT", "C2H6O", "64-17-5", "46.07",
    { "Boiling point": "78 °C", "Role": "SAM solvent, cleaning" }),
  M("IPA (2-propanol)", "SOLVENT", "C3H8O", "67-63-0", "60.10",
    { "Boiling point": "82 °C", "Role": "SAM solvent, rinsing, cleaning" }),
  M("Chlorobenzene", "SOLVENT", "C6H5Cl", "108-90-7", "112.56",
    { "Boiling point": "132 °C", "Role": "Antisolvent (spin coating)" }),
  M("Anisole", "SOLVENT", "C7H8O", "100-66-3", "108.14",
    { "Boiling point": "154 °C", "Role": "Greener antisolvent" }),
  M("Ethyl acetate", "SOLVENT", "C4H8O2", "141-78-6", "88.11",
    { "Boiling point": "77 °C", "Role": "Antisolvent / bathing" }),
  M("Toluene", "SOLVENT", "C7H8", "108-88-3", "92.14",
    { "Boiling point": "111 °C", "Role": "Antisolvent" }),
];

const RECIPES = [
  {
    name: "Triple-cation 1.61 eV (benchmark)",
    summary: "Cs0.05(FA0.83MA0.17)0.95Pb(I0.83Br0.17)3 — standard reference absorber",
    payload: {
      components: [
        { material: "FAI", amount: "1.00 M" },
        { material: "PbI2", amount: "1.10 M" },
        { material: "MABr", amount: "0.20 M" },
        { material: "PbBr2", amount: "0.22 M" },
        { material: "CsI (from 1.5 M DMSO stock)", amount: "0.06 M" },
      ],
      solvents: "DMF : DMSO = 4 : 1 (v/v)",
      concentration: "≈1.3 M total Pb",
      procedure: "Dissolve at RT 2 h in glovebox; 10 % PbI2 excess. Filter 0.22 µm PTFE before coating. Anneal 100 °C / 30 min.",
    },
  },
  {
    name: "Wide-gap 1.68 eV (tandem top cell)",
    summary: "Cs0.22FA0.78Pb(I0.85Br0.15)3 + MACl — for perovskite/Si tandems",
    payload: {
      components: [
        { material: "FAI", amount: "1.09 M" },
        { material: "CsI", amount: "0.31 M" },
        { material: "PbI2", amount: "1.19 M" },
        { material: "PbBr2", amount: "0.21 M" },
        { material: "MACl (additive)", amount: "0.5 mol%" },
      ],
      solvents: "DMF : DMSO = 3 : 1 (v/v)",
      concentration: "1.4 M",
      procedure: "Stir overnight RT in glovebox. Slot-die/blade in dry air (<1 % RH) with N2 knife; anneal 100 °C / 20 min.",
    },
  },
];

(async () => {
  const org = await db.organization.findFirstOrThrow({ where: { orgNumber: 1 } });
  let created = 0, skipped = 0;
  for (const m of MATERIALS) {
    const exists = await db.material.findFirst({ where: { organizationId: org.id, name: m.name } });
    if (exists) { skipped++; continue; }
    await db.material.create({ data: { ...m, organizationId: org.id } });
    created++;
  }
  let rc = 0;
  for (const r of RECIPES) {
    const exists = await db.recipe.findFirst({ where: { organizationId: org.id, name: r.name } });
    if (exists) continue;
    await db.recipe.create({ data: { ...r, organizationId: org.id } });
    rc++;
  }
  console.log(`materials created ${created}, skipped ${skipped}; recipes created ${rc}`);
  await db.$disconnect();
})();
