import { PrismaClient, ProcessKind } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

type Def = { name: string; unit: string; defaultValue: string };

async function main() {
  const org = await db.organization.upsert({
    where: { slug: "pheno" },
    update: {},
    create: { name: "Pheno", slug: "pheno" },
  });

  const adminPass = await bcrypt.hash("pheno2026", 10);
  const staffPass = await bcrypt.hash("lab2026", 10);

  const admin = await db.user.upsert({
    where: { email: "mike@ultiprice.com" },
    update: { role: "ADMIN", organizationId: org.id },
    create: { email: "mike@ultiprice.com", name: "Michael", passwordHash: adminPass, role: "ADMIN", organizationId: org.id },
  });
  const manager = await db.user.upsert({
    where: { email: "manager@pheno.lab" },
    update: {},
    create: { email: "manager@pheno.lab", name: "Lab Manager", passwordHash: staffPass, role: "MANAGER", organizationId: org.id },
  });
  const tech = await db.user.upsert({
    where: { email: "tech@pheno.lab" },
    update: { role: "TECHNICIAN" },
    create: { email: "tech@pheno.lab", name: "Lab Technician", passwordHash: staffPass, role: "TECHNICIAN", organizationId: org.id },
  });

  // ---- Processes: the overarching layer, each with its own parameter set ----
  let pos = 0;
  const proc = (name: string, kind: ProcessKind, icon: string, parameters: Def[]) =>
    db.process.create({ data: { organizationId: org.id, name, kind, icon, parameters, position: pos++ } });

  const pCleaning = await proc("Cleaning / washing", "PROCESSING", "FlaskConical", [
    { name: "Solvent sequence", unit: "", defaultValue: "DIW → acetone → IPA" },
    { name: "Time per solvent", unit: "min", defaultValue: "15" },
    { name: "Bath temperature", unit: "°C", defaultValue: "40" },
    { name: "Drying method", unit: "", defaultValue: "N₂ gun" },
  ]);
  const pSurface = await proc("Surface treatment", "PROCESSING", "Sun", [
    { name: "Treatment type", unit: "", defaultValue: "UV-Ozone" },
    { name: "Duration", unit: "min", defaultValue: "20" },
    { name: "Power", unit: "W", defaultValue: "" },
    { name: "Gas", unit: "", defaultValue: "O₂" },
  ]);
  const pSpin = await proc("Spin coating", "PROCESSING", "Disc", [
    { name: "Spin speed", unit: "rpm", defaultValue: "4000" },
    { name: "Acceleration", unit: "rpm/s", defaultValue: "2000" },
    { name: "Spin time", unit: "s", defaultValue: "30" },
    { name: "Dispense volume", unit: "µL", defaultValue: "80" },
    { name: "Antisolvent", unit: "", defaultValue: "chlorobenzene" },
    { name: "Antisolvent timing", unit: "s", defaultValue: "10" },
  ]);
  const pBlade = await proc("Blade coating", "PROCESSING", "Slice", [
    { name: "Coating speed", unit: "mm/s", defaultValue: "5" },
    { name: "Blade gap", unit: "µm", defaultValue: "100" },
    { name: "Dispense volume", unit: "µL", defaultValue: "10" },
    { name: "Substrate temperature", unit: "°C", defaultValue: "25" },
  ]);
  const pSlotDie = await proc("Slot-die coating", "PROCESSING", "AlignVerticalJustifyEnd", [
    { name: "Coating speed", unit: "mm/s", defaultValue: "3" },
    { name: "Pump rate", unit: "µL/min", defaultValue: "80" },
    { name: "Coating gap", unit: "µm", defaultValue: "150" },
    { name: "Wet film thickness", unit: "µm", defaultValue: "12" },
    { name: "N₂ knife pressure", unit: "kPa", defaultValue: "20" },
    { name: "Substrate temperature", unit: "°C", defaultValue: "25" },
  ]);
  const pSpray = await proc("Spray coating", "PROCESSING", "SprayCan", [
    { name: "Nozzle pressure", unit: "kPa", defaultValue: "100" },
    { name: "Solution flow rate", unit: "mL/min", defaultValue: "1" },
    { name: "Nozzle-substrate distance", unit: "cm", defaultValue: "10" },
    { name: "Substrate temperature", unit: "°C", defaultValue: "60" },
    { name: "Number of passes", unit: "", defaultValue: "3" },
  ]);
  const pInkjet = await proc("Inkjet printing", "PROCESSING", "Printer", [
    { name: "Drop spacing", unit: "µm", defaultValue: "25" },
    { name: "Jetting voltage", unit: "V", defaultValue: "20" },
    { name: "Print speed", unit: "mm/s", defaultValue: "100" },
    { name: "Nozzle temperature", unit: "°C", defaultValue: "30" },
    { name: "Substrate temperature", unit: "°C", defaultValue: "40" },
  ]);
  const pAnneal = await proc("Thermal anneal", "PROCESSING", "Flame", [
    { name: "Temperature", unit: "°C", defaultValue: "100" },
    { name: "Duration", unit: "min", defaultValue: "10" },
    { name: "Ramp rate", unit: "°C/min", defaultValue: "5" },
  ]);
  const pSputter = await proc("Sputter PVD", "PROCESSING", "Box", [
    { name: "Power", unit: "W", defaultValue: "60" },
    { name: "Power type", unit: "", defaultValue: "RF" },
    { name: "Ar flow", unit: "sccm", defaultValue: "20" },
    { name: "Working pressure", unit: "mbar", defaultValue: "3e-3" },
    { name: "Target thickness", unit: "nm", defaultValue: "100" },
    { name: "Deposition rate", unit: "Å/s", defaultValue: "1" },
  ]);
  const pEvap = await proc("Thermal evaporation", "PROCESSING", "ArrowUpFromLine", [
    { name: "Target thickness", unit: "nm", defaultValue: "30" },
    { name: "Deposition rate", unit: "Å/s", defaultValue: "0.2" },
    { name: "Base pressure", unit: "mbar", defaultValue: "1e-6" },
    { name: "Source temperature", unit: "°C", defaultValue: "" },
  ]);
  const pALD = await proc("ALD", "PROCESSING", "Layers", [
    { name: "Precursor A", unit: "", defaultValue: "TMA" },
    { name: "Precursor B", unit: "", defaultValue: "H₂O" },
    { name: "Cycles", unit: "", defaultValue: "150" },
    { name: "Chamber temperature", unit: "°C", defaultValue: "100" },
    { name: "Pulse / purge time", unit: "s", defaultValue: "0.1 / 10" },
    { name: "Growth per cycle", unit: "Å", defaultValue: "1.1" },
  ]);
  const pLaser = await proc("Laser scribing", "PROCESSING", "Zap", [
    { name: "Scribe line", unit: "", defaultValue: "P1" },
    { name: "Laser wavelength", unit: "nm", defaultValue: "532" },
    { name: "Laser power", unit: "W", defaultValue: "1.5" },
    { name: "Scan speed", unit: "mm/s", defaultValue: "500" },
    { name: "Pulse frequency", unit: "kHz", defaultValue: "50" },
    { name: "Line width", unit: "µm", defaultValue: "30" },
  ]);
  const pEncap = await proc("Encapsulation", "PROCESSING", "Package", [
    { name: "Encapsulant", unit: "", defaultValue: "UV-curable epoxy" },
    { name: "Cover", unit: "", defaultValue: "glass-glass" },
    { name: "Cure method", unit: "", defaultValue: "UV" },
    { name: "Cure time", unit: "min", defaultValue: "5" },
    { name: "Cure temperature", unit: "°C", defaultValue: "25" },
    { name: "Edge sealant", unit: "", defaultValue: "butyl rubber" },
  ]);
  const pJV = await proc("J-V — solar simulation", "CHARACTERIZATION", "SunMedium", [
    { name: "Spectrum", unit: "", defaultValue: "AM1.5G" },
    { name: "Irradiance", unit: "mW/cm²", defaultValue: "100" },
    { name: "Scan direction", unit: "", defaultValue: "Reverse + forward" },
    { name: "Scan rate", unit: "mV/s", defaultValue: "50" },
    { name: "Voltage range", unit: "V", defaultValue: "-0.1 … 1.2" },
    { name: "Cell area", unit: "cm²", defaultValue: "0.1" },
    { name: "Measurement temperature", unit: "°C", defaultValue: "25" },
  ]);
  const pEQE = await proc("EQE", "CHARACTERIZATION", "Activity", [
    { name: "Wavelength range", unit: "nm", defaultValue: "300–850" },
    { name: "Wavelength step", unit: "nm", defaultValue: "10" },
    { name: "Chopping frequency", unit: "Hz", defaultValue: "80" },
    { name: "Bias light", unit: "", defaultValue: "off" },
  ]);
  const pSEM = await proc("SEM", "CHARACTERIZATION", "Search", [
    { name: "Accelerating voltage", unit: "kV", defaultValue: "5" },
    { name: "Magnification", unit: "", defaultValue: "×50 000" },
    { name: "Detector mode", unit: "", defaultValue: "SE" },
    { name: "Working distance", unit: "mm", defaultValue: "8" },
  ]);
  const pEllips = await proc("Ellipsometry", "CHARACTERIZATION", "Waves", [
    { name: "Wavelength range", unit: "nm", defaultValue: "245–1690" },
    { name: "Angle of incidence", unit: "°", defaultValue: "65/70/75" },
    { name: "Spots per sample", unit: "", defaultValue: "3" },
    { name: "Optical model", unit: "", defaultValue: "Cauchy" },
  ]);
  const pXRD = await proc("XRD", "CHARACTERIZATION", "BarChart3", [
    { name: "Source", unit: "", defaultValue: "Cu Kα" },
    { name: "2θ range", unit: "°", defaultValue: "10–60" },
    { name: "Step size", unit: "°", defaultValue: "0.02" },
    { name: "Scan speed", unit: "°/min", defaultValue: "4" },
  ]);
  const pPL = await proc("Photoluminescence", "CHARACTERIZATION", "Lightbulb", [
    { name: "Excitation wavelength", unit: "nm", defaultValue: "450" },
    { name: "Excitation power", unit: "mW", defaultValue: "1" },
    { name: "Integration time", unit: "ms", defaultValue: "100" },
    { name: "Spot size", unit: "µm", defaultValue: "50" },
  ]);
  const pProf = await proc("Profilometry", "CHARACTERIZATION", "TrendingUp", [
    { name: "Scan length", unit: "µm", defaultValue: "1000" },
    { name: "Stylus force", unit: "mg", defaultValue: "3" },
    { name: "Scan speed", unit: "µm/s", defaultValue: "100" },
  ]);

  // ---- Locations ----
  const loc = (name: string) => db.location.create({ data: { organizationId: org.id, name } });
  const locPero = await loc("Building A — Perovskite lab");
  const locChar = await loc("Building A — Characterization room");
  const locGB = await loc("Glovebox line 1");

  // ---- Environments ----
  const env = async (name: string, conditions: Def[]) =>
    db.labEnvironment.create({ data: { organizationId: org.id, name, conditions } });

  const glovebox = await env("Glovebox N₂", [
    { name: "O₂", unit: "ppm", defaultValue: "<0.1" },
    { name: "H₂O", unit: "ppm", defaultValue: "<0.1" },
    { name: "Temperature", unit: "°C", defaultValue: "25" },
  ]);
  await env("Dry air", [
    { name: "Relative humidity", unit: "%", defaultValue: "<10" },
    { name: "Temperature", unit: "°C", defaultValue: "25" },
  ]);
  const ambient = await env("Ambient", [
    { name: "Relative humidity", unit: "%", defaultValue: "45" },
    { name: "Temperature", unit: "°C", defaultValue: "22" },
  ]);
  const vacuum = await env("Vacuum", [{ name: "Base pressure", unit: "mbar", defaultValue: "1e-6" }]);
  await env("Clean room", [
    { name: "Particle count", unit: "class", defaultValue: "ISO 6" },
    { name: "Relative humidity", unit: "%", defaultValue: "45" },
    { name: "Temperature", unit: "°C", defaultValue: "21" },
  ]);

  // ---- Equipment ----
  const eq = async (processId: string, name: string, make: string, model: string, assetTag: string, locationId: string | null, parameters: Def[]) =>
    db.equipment.create({ data: { organizationId: org.id, processId, name, make, model, assetTag, locationId, parameters } });

  const ultrasonic = await eq(pCleaning.id, "Ultrasonic bath — Elmasonic S60H", "Elma", "Elmasonic S60H", "UB-01", locPero.id, [
    { name: "Solvent sequence", unit: "", defaultValue: "DIW → acetone → IPA" },
    { name: "Time per solvent", unit: "min", defaultValue: "15" },
    { name: "Bath temperature", unit: "°C", defaultValue: "40" },
  ]);
  const uvo = await eq(pSurface.id, "UVO cleaner — Ossila L2002A", "Ossila", "L2002A", "UV-01", locPero.id, [
    { name: "Treatment type", unit: "", defaultValue: "UV-Ozone" },
    { name: "Duration", unit: "min", defaultValue: "20" },
    { name: "Gas", unit: "", defaultValue: "O₂" },
  ]);
  await eq(pSpin.id, "Spin coater — Laurell WS-650", "Laurell", "WS-650MZ-23NPPB", "SC-01", locGB.id, [
    { name: "Spin speed", unit: "rpm", defaultValue: "4000" },
    { name: "Acceleration", unit: "rpm/s", defaultValue: "2000" },
    { name: "Spin time", unit: "s", defaultValue: "30" },
    { name: "Dispense volume", unit: "µL", defaultValue: "80" },
  ]);
  const blade = await eq(pBlade.id, "Blade coater — Zehntner ZAA 2300", "Zehntner", "ZAA 2300", "BC-01", locGB.id, [
    { name: "Coating speed", unit: "mm/s", defaultValue: "5" },
    { name: "Blade gap", unit: "µm", defaultValue: "100" },
    { name: "Dispense volume", unit: "µL", defaultValue: "10" },
  ]);
  const slotdie = await eq(pSlotDie.id, "Slot-die coater — FOM nanoRC", "FOM Technologies", "nanoRC", "SD-01", locGB.id, [
    { name: "Coating speed", unit: "mm/s", defaultValue: "3" },
    { name: "Pump rate", unit: "µL/min", defaultValue: "80" },
    { name: "Coating gap", unit: "µm", defaultValue: "150" },
    { name: "N₂ knife pressure", unit: "kPa", defaultValue: "20" },
  ]);
  const hotplate = await eq(pAnneal.id, "Hotplate — IKA C-MAG HS 7", "IKA", "C-MAG HS 7", "HP-02", locGB.id, [
    { name: "Temperature", unit: "°C", defaultValue: "100" },
    { name: "Duration", unit: "min", defaultValue: "10" },
    { name: "Ramp rate", unit: "°C/min", defaultValue: "5" },
  ]);
  const evaporator = await eq(pEvap.id, "Thermal evaporator — Angstrom Nexdep", "Angstrom Engineering", "Nexdep", "EV-01", locPero.id, [
    { name: "Target thickness", unit: "nm", defaultValue: "30" },
    { name: "Deposition rate", unit: "Å/s", defaultValue: "0.2" },
    { name: "Base pressure", unit: "mbar", defaultValue: "1e-6" },
  ]);
  const sputter = await eq(pSputter.id, "Sputter PVD — AJA Orion 5", "AJA International", "Orion 5", "SP-01", locPero.id, [
    { name: "Power", unit: "W", defaultValue: "60" },
    { name: "Ar flow", unit: "sccm", defaultValue: "20" },
    { name: "Target thickness", unit: "nm", defaultValue: "100" },
  ]);
  const solarsim = await eq(pJV.id, "Solar simulator — Enlitech SS-F5-3A", "Enlitech", "SS-F5-3A", "SS-01", locChar.id, [
    { name: "Spectrum", unit: "", defaultValue: "AM1.5G" },
    { name: "Scan direction", unit: "", defaultValue: "Reverse + forward" },
    { name: "Scan rate", unit: "mV/s", defaultValue: "50" },
  ]);
  const sem = await eq(pSEM.id, "SEM — JEOL JSM-7610F", "JEOL", "JSM-7610F", "SEM-01", locChar.id, [
    { name: "Accelerating voltage", unit: "kV", defaultValue: "5" },
    { name: "Magnification", unit: "", defaultValue: "×50 000" },
  ]);
  const ellipsometer = await eq(pEllips.id, "Ellipsometer — J.A. Woollam M-2000", "J.A. Woollam", "M-2000", "EL-01", locChar.id, [
    { name: "Angle of incidence", unit: "°", defaultValue: "65/70/75" },
    { name: "Spots per sample", unit: "", defaultValue: "3" },
  ]);

  // ---- Materials ----
  const mat = (processId: string | null, name: string, composition = "") =>
    db.material.create({ data: { organizationId: org.id, processId, name, composition } });
  const ink = await mat(pSlotDie.id, "Perovskite ink — TC-1.68", "Cs0.05(FA0.90MA0.10)0.95Pb(I0.95Br0.05)3, 1.4 M in DMF:DMSO 4:1");
  const inkWide = await mat(pSlotDie.id, "Perovskite ink — TC-1.79 (wide gap)", "Cs0.20(FA0.85MA0.15)0.80Pb(I0.75Br0.25)3, 1.3 M in DMF:DMSO 4:1");
  const samMat = await mat(pBlade.id, "Me-4PACz 0.5 mg/mL", "Me-4PACz in ethanol");
  const c60 = await mat(pEvap.id, "C60", "C60, 30 nm");
  const bcp = await mat(pEvap.id, "BCP", "bathocuproine, 8 nm");
  await mat(pSputter.id, "ITO target", "In2O3:SnO2 90:10");
  await mat(pEncap.id, "UV-curable epoxy", "encapsulation resin");

  // ---- Presets ----
  const gbCond = { "O₂": "<0.1", "H₂O": "<0.1", Temperature: "25" };
  await db.preset.createMany({
    data: [
      {
        organizationId: org.id, kind: "STEP", processId: pAnneal.id, name: "SAM anneal 100 °C · 10 min", createdById: admin.id, usageCount: 8,
        payload: { equipmentId: hotplate.id, environmentId: glovebox.id, environmentConditions: gbCond, materials: [], parameters: [
          { name: "Temperature", unit: "°C", value: "100", source: "process" },
          { name: "Duration", unit: "min", value: "10", source: "process" },
          { name: "Ramp rate", unit: "°C/min", value: "5", source: "process" },
        ]},
      },
      {
        organizationId: org.id, kind: "STEP", processId: pSlotDie.id, name: "Perovskite slot-die — TC-1.68", createdById: admin.id, usageCount: 6,
        payload: { equipmentId: slotdie.id, environmentId: glovebox.id, environmentConditions: gbCond, materials: [{ materialId: ink.id, amount: "" }], parameters: [
          { name: "Coating speed", unit: "mm/s", value: "3", source: "process" },
          { name: "Pump rate", unit: "µL/min", value: "80", source: "process" },
          { name: "Coating gap", unit: "µm", value: "150", source: "process" },
          { name: "N₂ knife pressure", unit: "kPa", value: "20", source: "process" },
        ]},
      },
      {
        organizationId: org.id, kind: "STEP", processId: pCleaning.id, name: "Standard glass wash", createdById: admin.id, usageCount: 12,
        payload: { equipmentId: ultrasonic.id, environmentId: ambient.id, environmentConditions: {}, materials: [], parameters: [
          { name: "Solvent sequence", unit: "", value: "DIW → acetone → IPA", source: "process" },
          { name: "Time per solvent", unit: "min", value: "15", source: "process" },
          { name: "Bath temperature", unit: "°C", value: "40", source: "process" },
        ]},
      },
      {
        organizationId: org.id, kind: "CHARACTERIZATION", processId: pJV.id, name: "J-V AM1.5G reverse+forward", createdById: admin.id, usageCount: 9,
        payload: { equipmentId: solarsim.id, environmentId: glovebox.id, environmentConditions: gbCond, settings: { Spectrum: "AM1.5G", "Scan direction": "Reverse + forward", "Scan rate": "50 mV/s" }, sampleScope: "all" },
      },
      {
        organizationId: org.id, kind: "CHARACTERIZATION", processId: pSEM.id, name: "SEM cross-section ×50k", createdById: admin.id, usageCount: 4,
        payload: { equipmentId: sem.id, environmentId: vacuum.id, environmentConditions: {}, settings: { "Accelerating voltage": "5 kV", Magnification: "×50 000" }, sampleScope: "per-group" },
      },
    ],
  });

  await db.counter.upsert({
    where: { organizationId_year: { organizationId: org.id, year: 2026 } },
    update: {},
    create: { organizationId: org.id, year: 2026, next: 2 },
  });

  // ---- Demo experiment with a v2 test plan ----
  const testPlan = {
    groups: [
      { label: "A", samples: 3, isControl: true },
      { label: "B", samples: 3, isControl: false },
      { label: "C", samples: 3, isControl: false },
    ],
    variables: [
      {
        kind: "parameter", processId: pAnneal.id, parameter: "Temperature", unit: "°C",
        values: { A: "100", B: "120", C: "140" },
      },
    ],
  };

  const exp = await db.experiment.create({
    data: {
      organizationId: org.id,
      code: "EXP-2026-001",
      title: "Triple-cation n-i-p — anneal temperature series",
      status: "DRAFT",
      observation: "Batch 079 devices lost ~2 % PCE after 120 h; PL maps show ion migration near the HTL interface.",
      problem: "Is the perovskite anneal window causing incomplete crystallization and the observed instability?",
      hypothesis: "Annealing at 120 °C for 30 min (vs 100 / 140 °C) maximizes grain size without PbI2 excess, improving stability.",
      metadata: { testPlan },
      createdById: admin.id,
      members: { create: [{ userId: manager.id }, { userId: tech.id }] },
      samples: {
        create: [
          { code: "S1", variationGroup: "A" }, { code: "S2", variationGroup: "A" }, { code: "S3", variationGroup: "A" },
          { code: "S4", variationGroup: "B" }, { code: "S5", variationGroup: "B" }, { code: "S6", variationGroup: "B" },
          { code: "S7", variationGroup: "C" }, { code: "S8", variationGroup: "C" }, { code: "S9", variationGroup: "C" },
        ],
      },
    },
  });

  const step = (
    position: number, processId: string, name: string,
    equipmentId: string | null, environmentId: string | null, environmentConditions: Record<string, string>,
    materials: { materialId: string; amount: string }[],
    params: { name: string; unit: string; value: string; source?: string }[]
  ) =>
    db.processStep.create({
      data: {
        experimentId: exp.id, position, processId, name, equipmentId, environmentId, environmentConditions,
        materials: { create: materials.map((m, i) => ({ position: i, ...m })) },
        parameters: { create: params.map((p, i) => ({ position: i, source: "process", ...p })) },
      },
      include: { parameters: true },
    });

  await step(0, pCleaning.id, "Glass washing", ultrasonic.id, ambient.id, {}, [], [
    { name: "Solvent sequence", unit: "", value: "DIW → acetone → IPA" },
    { name: "Time per solvent", unit: "min", value: "15" },
    { name: "Bath temperature", unit: "°C", value: "40" },
  ]);
  await step(1, pSurface.id, "UV-Ozone treatment", uvo.id, ambient.id, {}, [], [
    { name: "Treatment type", unit: "", value: "UV-Ozone" },
    { name: "Duration", unit: "min", value: "20" },
    { name: "Gas", unit: "", value: "O₂" },
  ]);
  await step(2, pBlade.id, "Blade coat — SAM", blade.id, glovebox.id, gbCond, [{ materialId: samMat.id, amount: "" }], [
    { name: "Coating speed", unit: "mm/s", value: "5" },
    { name: "Blade gap", unit: "µm", value: "100" },
    { name: "Dispense volume", unit: "µL", value: "10" },
  ]);
  await step(3, pAnneal.id, "Thermal anneal — SAM", hotplate.id, glovebox.id, gbCond, [], [
    { name: "Temperature", unit: "°C", value: "100" },
    { name: "Duration", unit: "min", value: "10" },
    { name: "Ramp rate", unit: "°C/min", value: "5" },
  ]);
  await step(4, pSlotDie.id, "Slot-die — perovskite", slotdie.id, glovebox.id, gbCond, [{ materialId: ink.id, amount: "" }], [
    { name: "Coating speed", unit: "mm/s", value: "3" },
    { name: "Pump rate", unit: "µL/min", value: "80" },
    { name: "N₂ knife pressure", unit: "kPa", value: "20" },
  ]);
  const anneal = await step(5, pAnneal.id, "Thermal anneal — perovskite", hotplate.id, glovebox.id, gbCond, [], [
    { name: "Temperature", unit: "°C", value: "100" },
    { name: "Duration", unit: "min", value: "30" },
    { name: "Ramp rate", unit: "°C/min", value: "5" },
  ]);
  await step(6, pEvap.id, "Evaporation — C60 / BCP", evaporator.id, vacuum.id, { "Base pressure": "1e-6" },
    [{ materialId: c60.id, amount: "30 nm" }, { materialId: bcp.id, amount: "8 nm" }], [
    { name: "Deposition rate", unit: "Å/s", value: "0.2" },
    { name: "Base pressure", unit: "mbar", value: "1e-6" },
  ]);
  await step(7, pSputter.id, "Sputter — ITO electrode", sputter.id, vacuum.id, {}, [], [
    { name: "Power", unit: "W", value: "60" },
    { name: "Ar flow", unit: "sccm", value: "20" },
    { name: "Target thickness", unit: "nm", value: "100" },
  ]);

  const tempParam = anneal.parameters.find((p) => p.name === "Temperature")!;
  await db.parameterVariation.createMany({
    data: [
      { parameterId: tempParam.id, variationGroup: "A", value: "100" },
      { parameterId: tempParam.id, variationGroup: "B", value: "120" },
      { parameterId: tempParam.id, variationGroup: "C", value: "140" },
    ],
  });

  await db.characterization.createMany({
    data: [
      { experimentId: exp.id, position: 0, processId: pJV.id, name: "J-V — solar simulation", equipmentId: solarsim.id, environmentId: glovebox.id, environmentConditions: gbCond, settings: { Spectrum: "AM1.5G", "Scan direction": "Reverse + forward", "Scan rate": "50 mV/s" }, sampleScope: "all" },
      { experimentId: exp.id, position: 1, processId: pSEM.id, name: "SEM — cross-section", equipmentId: sem.id, environmentId: vacuum.id, settings: { "Accelerating voltage": "5 kV", Magnification: "×50 000" }, sampleScope: "per-group" },
      { experimentId: exp.id, position: 2, processId: pEllips.id, name: "Ellipsometry — thickness", equipmentId: ellipsometer.id, environmentId: ambient.id, settings: { Target: "Transport layers", "Spots per sample": "3" }, sampleScope: "all" },
    ],
  });

  // Auto-labels: derived from processes, equipment, materials, and variables.
  const autoLabels = [
    "Thermal anneal", "Slot-die coating", "Blade coating", "var:Temperature",
    "Perovskite ink — TC-1.68", "Me-4PACz",
  ];
  for (const name of autoLabels) {
    const label = await db.label.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      update: {},
      create: { organizationId: org.id, name },
    });
    await db.experimentLabel.create({ data: { experimentId: exp.id, labelId: label.id } });
  }

  console.log("Seed complete:", org.name, exp.code);
  // silence unused warnings for processes seeded only for their parameter sets
  void [pSpray, pInkjet, pALD, pLaser, pEncap, pEQE, pXRD, pPL, pProf, inkWide, tech];
}

main().finally(() => db.$disconnect());
