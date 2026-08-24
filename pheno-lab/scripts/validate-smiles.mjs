import { PrismaClient } from "@prisma/client";
import SmilesDrawer from "smiles-drawer";
const db = new PrismaClient();
const mats = await db.material.findMany({ where: { smiles: { not: "" } }, select: { name: true, smiles: true } });
const parser = SmilesDrawer.Parser ?? SmilesDrawer.default?.Parser;
let bad = [];
for (const m of mats) {
  try { parser.parse(m.smiles); } catch (e) { bad.push([m.name, m.smiles, String(e).slice(0,60)]); }
}
console.log(`checked ${mats.length}; invalid: ${bad.length}`);
bad.forEach(b => console.log(" BAD:", b[0], "|", b[1], "|", b[2]));
await db.$disconnect();
