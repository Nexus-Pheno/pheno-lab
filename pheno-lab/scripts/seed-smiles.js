const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const SMILES = {
  "Me-4PACz": "Cc1ccc2c(c1)c1cc(C)ccc1n2CCCCP(=O)(O)O",
  "2PACz": "OP(=O)(O)CCn1c2ccccc2c2ccccc21",
  "MeO-2PACz": "COc1ccc2c(c1)c1cc(OC)ccc1n2CCP(=O)(O)O",
  "FAI (formamidinium iodide)": "NC(=[NH2+])N.[I-]",
  "MAI (methylammonium iodide)": "C[NH3+].[I-]",
  "MABr (methylammonium bromide)": "C[NH3+].[Br-]",
  "MACl (methylammonium chloride)": "C[NH3+].[Cl-]",
  "C60 (fullerene)": "",
  "BCP (bathocuproine)": "Cc1cc(-c2ccccc2)c2ccc3c(-c4ccccc4)cc(C)nc3c2n1",
  "DMF (N,N-dimethylformamide)": "CN(C)C=O",
  "DMSO (dimethyl sulfoxide)": "CS(C)=O",
  "NMP (N-methyl-2-pyrrolidone)": "CN1CCCC1=O",
  "2-Methoxyethanol": "COCCO",
  "Ethanol (anhydrous)": "CCO",
  "IPA (2-propanol)": "CC(C)O",
  "Chlorobenzene": "Clc1ccccc1",
  "Anisole": "COc1ccccc1",
  "Ethyl acetate": "CCOC(C)=O",
  "Toluene": "Cc1ccccc1",
  "TMA (for ALD Al2O3)": "C[Al](C)C",
  "TDMASn (for ALD SnO2)": "CN(C)[Sn](N(C)C)(N(C)C)N(C)C",
  "TDMAT (for ALD TiO2)": "CN(C)[Ti](N(C)C)(N(C)C)N(C)C",
};
(async () => {
  let n = 0;
  for (const [name, smiles] of Object.entries(SMILES)) {
    if (!smiles) continue;
    const r = await db.material.updateMany({ where: { name }, data: { smiles } });
    n += r.count;
  }
  console.log("smiles set on", n, "materials");
  await db.$disconnect();
})();
