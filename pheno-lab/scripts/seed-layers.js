/* Device stack layers + the VCD process. Idempotent. */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

// Bottom-to-top for a p-i-n (inverted) cell.
const LAYERS = [
  ["SUBSTRATE", "Substrate / glass", "衬底 / 玻璃"],
  ["TCO_BOTTOM", "Bottom TCO", "底部透明导电层 (TCO)"],
  ["HTL", "HTL (SAM)", "空穴传输层 (SAM)"],
  ["PASS_BOTTOM", "Bottom passivation", "底部钝化层"],
  ["PEROVSKITE", "Perovskite", "钙钛矿吸收层"],
  ["PASS_TOP", "Top passivation", "顶部钝化层"],
  ["ETL", "ETL", "电子传输层 (ETL)"],
  ["TCO_TOP", "Top TCO", "顶部透明导电层 (TCO)"],
  ["ELECTRODE", "Metal electrode", "金属电极"],
  ["ENCAP", "Encapsulation", "封装层"],
];

// Sensible default layer per seeded process name (editable later).
const PROCESS_LAYER = {
  "Cleaning / washing": "SUBSTRATE",
  "Surface treatment": "TCO_BOTTOM",
  "Spin coating": "PEROVSKITE",
  "Blade coating": "PEROVSKITE",
  "Slot-die coating": "PEROVSKITE",
  "Spray coating": "PEROVSKITE",
  "Inkjet printing": "PEROVSKITE",
  "Vacuum-assisted crystallization (VCD)": "PEROVSKITE",
  "Thermal anneal": "PEROVSKITE",
  "Sputter PVD": "TCO_TOP",
  "Thermal evaporation": "ELECTRODE",
  "ALD": "PASS_TOP",
  "Laser scribing": "",
  "Encapsulation": "ENCAP",
};

(async () => {
  const orgs = await db.organization.findMany();
  for (const org of orgs) {
    for (let i = 0; i < LAYERS.length; i++) {
      const [code, name, nameZh] = LAYERS[i];
      const exists = await db.deviceLayer.findFirst({ where: { organizationId: org.id, code } });
      if (!exists) {
        await db.deviceLayer.create({ data: { organizationId: org.id, code, name, nameZh, position: i } });
      }
    }

    // VCD — vacuum-assisted crystallization, run right after wet deposition.
    const vcdName = "Vacuum-assisted crystallization (VCD)";
    let vcd = await db.process.findFirst({ where: { organizationId: org.id, name: vcdName } });
    if (!vcd) {
      const maxPos = await db.process.aggregate({ where: { organizationId: org.id }, _max: { position: true } });
      vcd = await db.process.create({
        data: {
          organizationId: org.id,
          name: vcdName,
          kind: "PROCESSING",
          icon: "Waves",
          position: (maxPos._max.position ?? 0) + 1,
          defaultLayer: "PEROVSKITE",
          parameters: [
            { name: "Base pressure", unit: "Pa", defaultValue: "20" },
            { name: "Pump-down rate", unit: "Pa/s", defaultValue: "50" },
            { name: "Hold time", unit: "s", defaultValue: "30" },
            { name: "Chamber temperature", unit: "°C", defaultValue: "25" },
            { name: "Vent rate", unit: "Pa/s", defaultValue: "100" },
          ],
        },
      });
    }

    // Apply default layers to existing processes that have none set.
    for (const [name, layer] of Object.entries(PROCESS_LAYER)) {
      if (!layer) continue;
      await db.process.updateMany({
        where: { organizationId: org.id, name, defaultLayer: "" },
        data: { defaultLayer: layer },
      });
    }
  }
  const n = await db.deviceLayer.count();
  const v = await db.process.count({ where: { name: { contains: "VCD" } } });
  console.log(`device layers: ${n}, VCD processes: ${v}`);
  await db.$disconnect();
})();
