/* Seed the built-in material categories (idempotent) + Additives. */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const CATS = [
  ["SAM", "Wet-process SAM materials", "湿法 SAM 材料"],
  ["PRECURSOR", "Wet-process perovskite precursors", "湿法钙钛矿前驱体"],
  ["ADDITIVE", "Additives", "添加剂"],
  ["EVAPORATION", "Thermal evaporation materials", "热蒸发材料"],
  ["SPUTTER", "Sputter materials", "溅射材料"],
  ["ALD", "ALD materials", "原子层沉积（ALD）材料"],
  ["SOLVENT", "Solvents", "溶剂"],
  ["OTHER", "Other / prepared solutions", "其他 / 配制溶液"],
];
(async () => {
  const orgs = await db.organization.findMany();
  for (const org of orgs) {
    for (let i = 0; i < CATS.length; i++) {
      const [code, name, nameZh] = CATS[i];
      const existing = await db.materialCategoryDef.findFirst({ where: { organizationId: org.id, code } });
      if (existing) continue;
      await db.materialCategoryDef.create({
        data: { organizationId: org.id, code, name, nameZh, position: i, builtIn: true },
      });
    }
  }
  console.log("categories seeded for", orgs.length, "org(s)");
  await db.$disconnect();
})();
