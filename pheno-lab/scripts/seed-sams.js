/* Seed the SAM library — the lab's focus area. Idempotent by name.
 * SMILES drive the 2D structure drawing in each wiki card. */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const S = (name, composition, smiles, cas, mw, props, notes) => ({
  name, category: "SAM", composition, smiles, casNumber: cas,
  molecularWeight: mw, properties: props, notes,
});

// Carbazole/triarylamine phosphonic & carboxylic acids used as hole-selective
// self-assembled monolayers on ITO / NiOx in p-i-n perovskite cells.
const SAMS = [
  S("2PACz", "C14H14NO3P — [2-(9H-carbazol-9-yl)ethyl]phosphonic acid",
    "OP(=O)(O)CCn1c2ccccc2c2ccccc21", "20999-38-6", "275.24",
    { "HOMO (eV)": "-5.71", "Solubility": "Ethanol / IPA (0.3–1 mg/mL)", "Anchor": "Phosphonic acid", "Typical conc.": "0.3 mg/mL", "Storage": "Inert, dark, RT" },
    "Baseline carbazole SAM; deep HOMO, widely used reference."),
  S("Me-4PACz", "C18H22NO3P — [4-(3,6-dimethyl-9H-carbazol-9-yl)butyl]phosphonic acid",
    "Cc1ccc2c(c1)c1cc(C)ccc1n2CCCCP(=O)(O)O", "2761610-58-2", "331.35",
    { "HOMO (eV)": "-5.72", "Solubility": "Ethanol / IPA", "Anchor": "Phosphonic acid", "Typical conc.": "0.3–1 mg/mL", "Storage": "Inert, dark, RT" },
    "Workhorse SAM for wide-gap and tandem top cells."),
  S("MeO-2PACz", "C16H18NO5P — [2-(3,6-dimethoxy-9H-carbazol-9-yl)ethyl]phosphonic acid",
    "COc1ccc2c(c1)c1cc(OC)ccc1n2CCP(=O)(O)O", "2359616-64-1", "335.29",
    { "HOMO (eV)": "-5.37", "Solubility": "Ethanol / IPA", "Anchor": "Phosphonic acid", "Storage": "Inert, dark, RT" },
    "Shallower HOMO — suits narrow-gap / Sn-Pb absorbers."),
  S("4PACz", "C16H18NO3P — [4-(9H-carbazol-9-yl)butyl]phosphonic acid",
    "OP(=O)(O)CCCCn1c2ccccc2c2ccccc21", "2755740-88-4", "303.30",
    { "HOMO (eV)": "-5.60", "Solubility": "Ethanol / IPA", "Anchor": "Phosphonic acid" },
    "Longer butyl spacer than 2PACz — denser packing on ITO."),
  S("3PACz", "C15H16NO3P — [3-(9H-carbazol-9-yl)propyl]phosphonic acid",
    "OP(=O)(O)CCCn1c2ccccc2c2ccccc21", "", "289.27",
    { "HOMO (eV)": "-5.65", "Anchor": "Phosphonic acid" },
    "Propyl spacer variant; intermediate between 2PACz and 4PACz."),
  S("Br-2PACz", "C14H13BrNO3P — [2-(3-bromo-9H-carbazol-9-yl)ethyl]phosphonic acid",
    "OP(=O)(O)CCn1c2ccccc2c2cc(Br)ccc21", "", "354.14",
    { "HOMO (eV)": "-5.80", "Anchor": "Phosphonic acid" },
    "Halogenated carbazole — deeper HOMO for high-Voc wide-gap cells."),
  S("CF3-2PACz", "C16H13F6NO3P — [2-(3,6-bis(trifluoromethyl)carbazol-9-yl)ethyl]phosphonic acid",
    "OP(=O)(O)CCn1c2ccc(C(F)(F)F)cc2c2cc(C(F)(F)F)ccc21", "", "411.24",
    { "HOMO (eV)": "-5.95", "Anchor": "Phosphonic acid", "Note": "Strong electron-withdrawing groups" },
    "Deepest-HOMO carbazole SAM in this set; wide-gap Voc booster."),
  S("Ph-2PACz", "C20H18NO3P — [2-(3-phenyl-9H-carbazol-9-yl)ethyl]phosphonic acid",
    "OP(=O)(O)CCn1c2ccccc2c2cc(-c3ccccc3)ccc21", "", "351.34",
    { "HOMO (eV)": "-5.65", "Anchor": "Phosphonic acid" },
    "Phenyl-extended conjugation; improves hole extraction kinetics."),
  S("EADR03", "Carbazole phosphonic acid with extended donor core",
    "COc1ccc2c(c1)c1cc(OC)ccc1n2CCCCP(=O)(O)O", "", "363.34",
    { "HOMO (eV)": "-5.40", "Anchor": "Phosphonic acid" },
    "Methoxy-substituted butyl analogue — shallower HOMO, good wetting."),
  S("MPA-CPA", "Carbazole–cyanoacrylic acid SAM",
    "N#CC(=Cc1ccc2c(c1)c1cc(OC)ccc1n2CCCP(=O)(O)O)C(=O)O", "", "465.4",
    { "HOMO (eV)": "-5.50", "Anchor": "Phosphonic + cyanoacrylic", "Note": "Dipole-enhancing acceptor group" },
    "High-efficiency SAM reported for >25 % p-i-n devices."),
  S("4PADCB", "C22H22NO3P — carbazole–biphenyl phosphonic acid",
    "OP(=O)(O)CCCCn1c2ccccc2c2ccccc21.c1ccccc1", "", "379.4",
    { "HOMO (eV)": "-5.55", "Anchor": "Phosphonic acid" },
    "Dicarbazole-biphenyl SAM for wide-gap tandem top cells."),
  S("PTAA (poly-triarylamine)", "(C24H25N)n — polymeric triarylamine",
    "CC(C)(c1ccccc1)N(c1ccccc1)c1ccccc1", "1333317-99-9", "~17000",
    { "HOMO (eV)": "-5.20", "Solubility": "Toluene, chlorobenzene", "Note": "Polymer HTL, not a true monolayer" },
    "Polymeric hole transporter often benchmarked against SAMs."),
  S("4-Methoxybenzoic acid (anchor)", "C8H8O3", "COc1ccc(C(=O)O)cc1", "100-09-4", "152.15",
    { "Anchor": "Carboxylic acid", "Role": "Interface dipole modifier" },
    "Simple carboxylic anchor used to tune ITO work function."),
  S("4-Fluorophenylphosphonic acid", "C6H6FO3P", "OP(=O)(O)c1ccc(F)cc1", "444-13-3", "176.08",
    { "Anchor": "Phosphonic acid", "Role": "Work-function tuning / co-SAM" },
    "Small co-adsorbate used to fill pinholes between bulky SAMs."),
  S("3-Aminopropyltriethoxysilane (APTES)", "C9H23NO3Si", "CCO[Si](OCC)(OCC)CCCN", "919-30-2", "221.37",
    { "Anchor": "Silane", "Role": "Adhesion / surface amination" },
    "Silane SAM for oxide surface functionalization."),
  S("Octadecyltrichlorosilane (OTS)", "C18H37Cl3Si", "CCCCCCCCCCCCCCCCCC[Si](Cl)(Cl)Cl", "112-04-9", "387.93",
    { "Anchor": "Chlorosilane", "Role": "Hydrophobic patterning" },
    "Used for hydrophobic patterning and dewetting studies."),
];

// A few common additives, now that Additives is its own category.
const ADDITIVES = [
  { name: "MACl (additive)", category: "ADDITIVE", composition: "CH6NCl", smiles: "C[NH3+].[Cl-]", casNumber: "593-51-1", molecularWeight: "67.52",
    properties: { "Role": "Crystallization / grain growth", "Typical loading": "0.3–0.5 molar eq.", "Note": "Volatile — leaves film on anneal" }, notes: "" },
  { name: "SnF2", category: "ADDITIVE", composition: "SnF2", smiles: "", casNumber: "7783-47-3", molecularWeight: "156.71",
    properties: { "Role": "Suppresses Sn(II) oxidation", "Typical loading": "5–10 mol%" }, notes: "Essential for Sn-Pb narrow-gap absorbers." },
  { name: "PEAI (phenethylammonium iodide)", category: "ADDITIVE", composition: "C8H12IN", smiles: "[NH3+]CCc1ccccc1.[I-]", casNumber: "151059-43-7", molecularWeight: "249.09",
    properties: { "Role": "Surface passivation (2D capping)", "Typical loading": "1–5 mM in IPA" }, notes: "Post-treatment for defect passivation." },
  { name: "OAI (octylammonium iodide)", category: "ADDITIVE", composition: "C8H20IN", smiles: "CCCCCCCC[NH3+].[I-]", casNumber: "27963-44-8", molecularWeight: "257.16",
    properties: { "Role": "Surface passivation", "Typical loading": "2–5 mM in IPA" }, notes: "" },
  { name: "RbI (additive)", category: "ADDITIVE", composition: "RbI", smiles: "", casNumber: "7790-29-6", molecularWeight: "212.37",
    properties: { "Role": "Phase stabilization", "Typical loading": "1–5 mol%" }, notes: "" },
  { name: "KI (potassium iodide)", category: "ADDITIVE", composition: "KI", smiles: "", casNumber: "7681-11-0", molecularWeight: "166.00",
    properties: { "Role": "Hysteresis suppression", "Typical loading": "1–5 mol%" }, notes: "" },
];

(async () => {
  const org = await db.organization.findFirstOrThrow({ where: { orgNumber: 1 } });
  let created = 0, updated = 0;
  for (const m of [...SAMS, ...ADDITIVES]) {
    const existing = await db.material.findFirst({ where: { organizationId: org.id, name: m.name } });
    if (existing) {
      await db.material.update({ where: { id: existing.id }, data: m });
      updated++;
    } else {
      await db.material.create({ data: { ...m, organizationId: org.id } });
      created++;
    }
  }
  const sams = await db.material.count({ where: { organizationId: org.id, category: "SAM" } });
  const adds = await db.material.count({ where: { organizationId: org.id, category: "ADDITIVE" } });
  console.log(`created ${created}, updated ${updated} — SAMs: ${sams}, additives: ${adds}`);
  await db.$disconnect();
})();
