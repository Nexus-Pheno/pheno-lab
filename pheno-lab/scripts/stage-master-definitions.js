#!/usr/bin/env node
/* Stage the "master definition list" reference folder into the quality gate.
 *
 * Source: Pheno Data/master definition list/
 *   材料/*.pdf              — Sigma-Aldrich MSDS + supplier product pages
 *   设备/*.pdf              — equipment specifications and purchase contracts
 *   TCO基底/*.docx          — FTO/ITO substrate specification tables
 *   真空工艺.docx            — ALD / thermal evaporation / sputtering recipes
 *   实验环境.docx            — glovebox and clean room conditions
 *   模组和器件设计/*.xlsx     — laser scribing P1–P4 parameters
 *   配方/钙钛矿配方.xlsx      — NOT staged: byte-identical to the file already ingested
 *
 * Values are transcribed as written. Where a source is ambiguous or
 * self-contradictory it is recorded in the item's confidence note rather than
 * silently resolved.
 *
 * Usage: node scripts/stage-master-definitions.js [--dry]
 */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const SRC = "master definition list";
const p = (name, unit, value) => ({ name, unit, value });
const cond = (name, unit, defaultValue) => ({ name, unit, defaultValue });

// ---------------------------------------------------------------- materials

const MSDS = [
  {
    name: "DMF (N,N-dimethylformamide)", composition: "C3H7NO", casNumber: "68-12-2",
    molecularWeight: "73.09", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "227056", "Synonym": "DMF", "Hazard": "Repr. 1B — may damage fertility or the unborn child" },
    source: "材料/DMF.pdf",
  },
  {
    name: "DMSO (dimethyl sulfoxide)", composition: "C2H6OS", casNumber: "67-68-5",
    molecularWeight: "78.13", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "D8418" },
    source: "材料/DMSO.pdf",
  },
  {
    name: "Ethanol (anhydrous)", composition: "C2H6O", casNumber: "64-17-5",
    molecularWeight: "46.07", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "493546", "Datasheet name": "Ethyl alcohol, Pure" },
    source: "材料/EtOH.pdf",
  },
  {
    name: "IPA (2-propanol)", composition: "C3H8O", casNumber: "67-63-0",
    molecularWeight: "60.10", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "I9030", "Datasheet name": "Isopropyl alcohol" },
    source: "材料/IPA.pdf",
  },
  {
    name: "NMP (N-methyl-2-pyrrolidone)", composition: "C5H9NO", casNumber: "872-50-4",
    molecularWeight: "99.13", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "328634", "Datasheet name": "1-Methyl-2-pyrrolidinone" },
    source: "材料/NMP.pdf",
  },
  {
    name: "BCP (bathocuproine)", category: "EVAPORATION", composition: "C26H20N2", casNumber: "4733-39-5",
    molecularWeight: "360.45", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "306008", "Synonym": "BCP" },
    source: "材料/BCP.pdf",
  },
  {
    name: "TDMASn (for ALD SnO2)", category: "ALD", composition: "C8H24N4Sn", casNumber: "1066-77-9",
    molecularWeight: "295.01", supplier: "苏州源展材料科技 (Suzhou Yuanzhan)", lot: "",
    properties: { "Appearance": "colourless liquid", "Stability": "air sensitive, moisture sensitive" },
    source: "材料/TDMASn.pdf",
    confidence:
      "From the supplier's product page. NOTE: that page's title reads 'bis(n,n'-di-tert-butylacetamidinato)iron(ii)' — a mismatched template on the vendor site — while the data block gives TDMASn, CAS 1066-77-9, C8H24N4Sn, 295.01. Worth confirming the CAS against your bottle.",
  },
  // --- new to the library ---
  {
    name: "TEG (triethylene glycol)", composition: "C6H14O4", casNumber: "112-27-6",
    molecularWeight: "150.17", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "PHR3826" },
    source: "材料/TEG.pdf",
  },
  {
    name: "Methanol (甲醇)", composition: "CH4O", casNumber: "67-56-1",
    molecularWeight: "32.04", supplier: "Sigma-Aldrich", lot: "",
    properties: { "Product number": "34860", "Synonym": "Methyl alcohol" },
    source: "材料/甲醇.pdf",
  },
  {
    name: "TDMAHf (for ALD HfO2)", category: "ALD", composition: "C8H24HfN4", casNumber: "19782-68-4",
    molecularWeight: "354.79", supplier: "苏州源展材料科技 (Suzhou Yuanzhan)", lot: "",
    properties: { "Product name": "Hf(NMe2)4", "Appearance": "colorless to pale yellow liquid", "Stability": "moisture sensitive, store cold" },
    source: "材料/TDMAHf.pdf",
  },
];

// TCO substrates — from the supplier specification tables.
const SUBSTRATES = [
  {
    name: "FTO glass — NSG TEC A7 (6–8 Ω/□)", supplier: "日本NSG",
    properties: { "Sheet resistance": "6–8 Ω/□", "Glass thickness": "2.2 mm", "Transmittance": ">80%", "Haze": "7%", "Film thickness": "550 nm", "Conductivity": "high", "Max temperature": "550 °C", "Surface roughness": "higher", "Abrasion resistance": "strong" },
  },
  {
    name: "FTO glass — NSG TEC15 (12–14 Ω/□)", supplier: "日本NSG",
    properties: { "Sheet resistance": "12–14 Ω/□", "Glass thickness": "1.6 mm / 2.2 mm", "Transmittance": ">85%", "Haze": "0.6%", "Film thickness": "350 nm", "Conductivity": "good", "Max temperature": "550 °C", "Surface roughness": "low", "Abrasion resistance": "strong" },
  },
  {
    name: "FTO glass — AGC (6–10 Ω/□)", supplier: "日本AGC",
    properties: { "Sheet resistance": "6–10 Ω/□", "Glass thickness": "2.2 mm and 2.5 mm", "Transmittance": ">83.8%", "Haze": "~11%", "Film thickness": "~320 nm", "Conductivity": "high", "Max temperature": "600–650 °C", "Surface roughness": "higher", "Abrasion resistance": "strong" },
  },
  {
    name: "ITO glass — AGC (7–9 Ω/□)", supplier: "日本AGC",
    properties: { "Sheet resistance": "7–9 Ω/□", "Glass thickness": "0.7 mm / 1.1 mm", "Transmittance": "~88%", "Haze": "<0.6% (0.7 mm) / <1% (1.1 mm)", "Film thickness": "180 nm", "Conductivity": "high", "Max temperature": "300 °C (0.7 mm) / 320 °C (1.1 mm)" },
  },
  {
    name: "ITO glass — AGC (10–15 Ω/□)", supplier: "日本AGC",
    properties: { "Sheet resistance": "10–15 Ω/□", "Glass thickness": "0.7 mm / 1.1 mm", "Transmittance": "~89%", "Haze": "<0.6% (0.7 mm) / <1% (1.1 mm)", "Film thickness": "150 nm", "Conductivity": "good", "Max temperature": "300 °C (0.7 mm) / 320 °C (1.1 mm)" },
  },
  {
    name: "ITO glass — AGC (12–17 Ω/□)", supplier: "日本AGC",
    properties: { "Sheet resistance": "12–17 Ω/□", "Glass thickness": "0.7 mm / 1.1 mm", "Transmittance": "~90%", "Haze": "<0.6% (0.7 mm) / <1% (1.1 mm)", "Film thickness": "100 nm", "Conductivity": "good", "Max temperature": "300 °C (0.7 mm) / 320 °C (1.1 mm)" },
  },
  {
    name: "Large-area module TCO glass — 优选", supplier: "优选",
    properties: { "TCO thickness (measured)": "120–135 nm", "Glass thickness (measured)": "1.097–1.110 mm", "Sheet resistance (measured)": "11.34–12.50 Ω/□", "Uniformity": "TCO 94.12% / glass 99.41% / Rs 95.13%", "Transmittance 400–800 nm": "88.79% avg", "Transmittance @550 nm": "93%" },
    confidence: "These are MEASURED batch values from 大面积模组TCO玻璃.pptx, not a vendor specification.",
  },
  {
    name: "Large-area module TCO glass — 亚玛顿", supplier: "亚玛顿",
    properties: { "TCO thickness (measured)": "162–169 nm", "Glass thickness (measured)": "1.958–1.972 mm", "Sheet resistance (measured)": "9.258–10.24 Ω/□", "Uniformity": "TCO 97.89% / glass 99.64% / Rs 94.96%", "Transmittance 400–800 nm": "84.05% avg (YMD-ITO)", "Transmittance @550 nm": "86.49%" },
    confidence: "MEASURED batch values from 大面积模组TCO玻璃.pptx, not a vendor specification.",
  },
];

// ---------------------------------------------------------------- equipment

const EQUIPMENT = [
  {
    name: "Thermal evaporator — 普诺逊 P210", make: "普诺逊真空科技 (Prunusen Vacuum)", model: "P210",
    processName: "Thermal evaporation", locationName: "",
    parameters: [
      { name: "Substrate size", unit: "mm", defaultValue: "210×210 ±0.2" },
      { name: "Edge dead zone", unit: "mm", defaultValue: "<2" },
      { name: "Uniformity (PbI2 @200nm)", unit: "%", defaultValue: "≤5" },
      { name: "Uniformity (CsBr @200nm)", unit: "%", defaultValue: "≤5" },
      { name: "Uniformity (C60 @20nm)", unit: "%", defaultValue: "≤5" },
      { name: "Rate stability MTC", unit: "%", defaultValue: "≤5 over 1.0–2.0 Å/s" },
      { name: "Thickness repeatability HTC", unit: "%", defaultValue: "≤5 (Ag @2000 Å)" },
      { name: "Alignment accuracy", unit: "µm", defaultValue: "≤±250 (mechanical)" },
      { name: "Ultimate vacuum", unit: "torr", defaultValue: "5.0E-7 within 6 h" },
      { name: "Base vacuum", unit: "torr", defaultValue: "5.0E-6 within 30 min" },
      { name: "Pressure hold", unit: "Pa", defaultValue: "<5 @12 h" },
      { name: "Evaporation sources", unit: "count", defaultValue: "4 fitted (3 in use, 1 spare)" },
      { name: "Thickness monitor probes", unit: "count", defaultValue: "4" },
    ],
    notes: "Resistive thermal evaporation for perovskite (PbI2, CsBr). Rear door nests into a glovebox for sample exchange. Spec V03, 2024-10-28.",
    source: "设备/普诺逊——P210 蒸镀腔体技术规格书V03.pdf",
  },
  {
    name: "Sputter PVD — 普迪 PD-450CS", make: "武汉普迪真空科技 (Wuhan Pudi Vacuum)", model: "PD-450CS",
    processName: "Sputter PVD", locationName: "",
    parameters: [
      { name: "Substrate size", unit: "mm", defaultValue: "<210×210" },
      { name: "Stage heating", unit: "°C", defaultValue: "room temperature – 300" },
      { name: "Targets", unit: "", defaultValue: "2 × rectangular magnetron, ~360×70 mm" },
      { name: "RF power supply", unit: "W", defaultValue: "2 × 600 (凡谷 RF)" },
      { name: "Thickness non-uniformity", unit: "%", defaultValue: "<±5 over 210×210 mm" },
      { name: "Target materials", unit: "", defaultValue: "ITO, …" },
    ],
    notes: "Large-area magnetron sputtering system; docks to a glovebox. Contract B202308A057-1, 2023-08-21.",
    source: "设备/B202308A057-1 …PD-450CS…pdf",
  },
  {
    name: "Perovskite film deposition system — 普迪 PD-400S", make: "武汉普迪真空科技 (Wuhan Pudi Vacuum)", model: "PD-400S",
    processName: "Thermal evaporation", locationName: "",
    parameters: [
      { name: "Substrate size", unit: "mm", defaultValue: "<200×200" },
      { name: "Source–substrate distance", unit: "mm", defaultValue: "0–50 adjustable" },
      { name: "Metal sources", unit: "count", defaultValue: "4 (water-cooled Cu electrode, W boat, 0.3 mL)" },
      { name: "Organic sources", unit: "count", defaultValue: "2" },
      { name: "Metal source max temperature", unit: "°C", defaultValue: "1650" },
      { name: "Organic source max temperature", unit: "°C", defaultValue: "600" },
      { name: "Evaporation power supply", unit: "", defaultValue: "TDK (Japan), constant-current / constant-voltage" },
      { name: "Control", unit: "", defaultValue: "Siemens PLC + PC, PID rate control from thickness monitor" },
    ],
    notes: "Contract B202308A057-2, 2023-08-21.",
    confidence:
      "MODEL CONFLICT: the file name says PD-450S but the contract's own product table says 型号规格 PD-400S. Staged as PD-400S (the contract body); please confirm against the machine's plate.",
    source: "设备/B202308A057-2 …PD-450S…pdf",
  },
  {
    name: "ALD — Exploiter E200S", make: "深圳市原速光电科技 (Shenzhen Yuansu Optoelectronics)", model: "Exploiter E200S 200×200",
    processName: "ALD", locationName: "",
    parameters: [
      { name: "Substrate size", unit: "mm", defaultValue: "≤200×200" },
      { name: "Stage temperature", unit: "°C", defaultValue: "up to 500, ±1" },
      { name: "Precursor lines", unit: "count", defaultValue: "3 (1 ambient, 2 heated)" },
      { name: "Precursor/line temperature", unit: "°C", defaultValue: "room temperature – 150" },
      { name: "Purge gas", unit: "", defaultValue: "N2 via imported MFC" },
      { name: "Vacuum gauges", unit: "count", defaultValue: "2 (capacitance + wide range)" },
    ],
    notes: "Atomic layer deposition for oxides, nitrides and metals; specified for Al2O3. Spec V1.2.",
    source: "设备/设备规格书-Exploiter E200S…pdf",
  },
  {
    name: "Thermal evaporator — 方昇 FS600-S8", make: "苏州方昇光电 (Suzhou Fangsheng Optoelectronics)", model: "FS600-S8",
    processName: "Thermal evaporation", locationName: "",
    parameters: [],
    notes: "Organic–metal vacuum thermal evaporator. Purchase contract 2022110111, 2022-11-01, 1 set.",
    confidence:
      "This PDF is a SCANNED contract — no text layer. Make, model, contract number and date were read from the rendered first page; the detailed configuration is in an appendix that was not transcribed. Parameters left empty rather than guessed.",
    source: "设备/方昇-小蒸镀仪合同.pdf",
  },
  {
    name: "Solar simulator — XES-40S3-RY-200 (AAA)", make: "巨力光电（北京）科技 (GiantForce Beijing)", model: "XES-40S3-RY-200",
    processName: "J-V — solar simulation", locationName: "",
    parameters: [{ name: "Classification", unit: "", defaultValue: "AAA" }],
    notes: "AAA-class solar simulator. Contract GFTECH221025, 1 unit.",
    confidence:
      "SCANNED contract — read from the rendered first page. The folder names it 日本三洋 (Sanyo) but the XES-40S3 series is San-Ei Electric; 巨力光电 is the supplier on the contract. Please confirm the actual manufacturer.",
    source: "设备/日本三洋-小太阳合同.pdf",
  },
  {
    name: "J-V measurement system — GiantForce IV", make: "巨力科技 (GiantForce / Juli Instruments)", model: "IV Measurement System",
    processName: "J-V — solar simulation", locationName: "",
    parameters: [{ name: "Software version", unit: "", defaultValue: "2.0.2206" }],
    notes: "Source-meter based I-V measurement software and hardware. giantforce.cn / julinst.com. This is the instrument whose export files the JV upload agent parses.",
    source: "设备/IV Measurement System Manual GF.pdf",
  },
  {
    name: "SEM — Phenom Nano G2", make: "Phenom Scientific (飞纳)", model: "Phenom Nano G2",
    processName: "SEM", locationName: "",
    parameters: [
      { name: "Resolution", unit: "nm", defaultValue: "<2.5" },
      { name: "Electron source", unit: "", defaultValue: "Schottky field emission" },
      { name: "Vacuum load time", unit: "s", defaultValue: "15 (automatic vacuum lock)" },
      { name: "EDS element range", unit: "", defaultValue: "B(5) – Cf(98)" },
    ],
    notes: "Desktop field-emission SEM with factory-integrated EDS; non-conductive samples imaged without sputter coating. Benchtop, vibration-tolerant, built-in magnetic shielding.",
    source: "设备/Phenom Nano G2.pdf",
  },
];

// ------------------------------------------------------------- environments

const ENVIRONMENTS = [
  {
    name: "Glovebox N₂ (Mikrouna)",
    conditions: [cond("O₂", "ppm", "<0.01"), cond("H₂O", "ppm", "<0.01"), cond("Box pressure", "mbar", "+1 to +6")],
    notes:
      "米开罗那 (Mikrouna) glovebox, 5N nitrogen. Used for small-area fabrication and testing. Circulation may start once the analyser reads <200 ppm; regeneration gas is 5–10% H₂ in inert, 40 L cylinder at 10 MPa.",
    source: "实验环境.docx + 设备/手套箱-说明书.pdf",
    confidence:
      "The <0.01 ppm figures are the lab's stated operating condition from 实验环境.docx; the 200 ppm in the manual is the threshold for starting circulation, not the working spec.",
  },
  {
    name: "Clean room — module line (2024–present)",
    conditions: [cond("Cleanliness", "class", "1k–10k"), cond("Relative humidity", "%", "25"), cond("Temperature", "°C", "20")],
    notes: "Module fabrication and testing from 2024 onward; rotary-wheel dehumidified air conditioning (转轮空调).",
    source: "实验环境.docx",
  },
  {
    name: "Clean room — module line (2023)",
    conditions: [cond("Cleanliness", "class", "10k"), cond("Relative humidity", "%", "40"), cond("Temperature", "°C", "30")],
    notes: "Historical configuration for 2023 module work — kept so older experiments can reference the conditions they actually ran under.",
    source: "实验环境.docx",
    confidence: "This is a SUPERSEDED environment, staged for historical accuracy. Reject it if you would rather not carry retired configurations in the library.",
  },
];

// ------------------------------------------------------- process recipes

const VACUUM = "真空工艺.docx";
const PRESETS = [
  // --- ALD ---
  {
    name: "ALD HfOx", processName: "ALD", source: VACUUM,
    parameters: [
      p("Chamber temperature", "°C", "85"), p("TDMAHf pulse", "ms", "200"), p("Purge after precursor", "s", "50"),
      p("Ozone pulse", "ms", "20"), p("Purge after oxidant", "s", "55"),
    ],
    notes: "腔体温度85℃，TDMAHf pulse 200 ms → purge 50s → Ozone pulse 20 ms → purge 55s",
  },
  {
    name: "ALD SnOx", processName: "ALD", source: VACUUM,
    parameters: [
      p("Chamber temperature", "°C", "90"), p("TDMASn pulse", "s", "1.5"), p("Purge after precursor", "s", "5"),
      p("H2O pulse", "s", "1.5"), p("Purge after oxidant", "s", "5"),
    ],
    notes: "腔体温度90℃，TDMASn pulse 1.5s → purge 5s → H2O pulse 1.5s → H2O 5s",
    confidence: "The source writes the final step as 'H2O 5s' rather than 'purge 5s' — read as the post-oxidant purge. Please confirm.",
  },
  {
    name: "ALD Al2O3 — encapsulation", processName: "ALD", source: VACUUM,
    parameters: [
      p("Chamber temperature", "°C", "60"), p("TMA pulse", "s", "0.5"), p("Purge after precursor", "s", "8"),
      p("H2O pulse", "s", "0.5"), p("Purge after oxidant", "s", "8"),
    ],
    notes: "封装层 — encapsulation layer.",
  },
  {
    name: "ALD Al2O3 — interface modification", processName: "ALD", source: VACUUM,
    parameters: [
      p("Chamber temperature", "°C", "70"), p("TMA pulse", "s", "0.5"), p("Purge after precursor", "s", "40"),
      p("H2O pulse", "s", "0.1"), p("Purge after oxidant", "s", "100"),
    ],
    notes: "界面修饰层 — interface modification layer.",
  },
  // --- thermal evaporation ---
  {
    name: "Evaporate C60", processName: "Thermal evaporation", source: VACUUM,
    parameters: [p("Deposition rate", "Å/s", "0.3"), p("Film thickness", "nm", "25")],
    notes: "热蒸镀 table, row 1.",
  },
  {
    name: "Evaporate BCP", processName: "Thermal evaporation", source: VACUUM,
    parameters: [p("Deposition rate", "Å/s", "0.2"), p("Film thickness", "nm", "8")],
    notes: "热蒸镀 table, row 2.",
  },
  {
    name: "Evaporate Cu", processName: "Thermal evaporation", source: VACUUM,
    parameters: [
      p("Deposition rate (first 10 nm)", "Å/s", "0.3"), p("Deposition rate (remainder)", "Å/s", "1.5"),
      p("Film thickness", "nm", "100"),
    ],
    notes: "前10nm以速率0.3A/s蒸镀，然后提升至1.5A/s的速率蒸镀完.",
  },
  {
    name: "Evaporate Ag", processName: "Thermal evaporation", source: VACUUM,
    parameters: [
      p("Deposition rate (first 10 nm)", "Å/s", "0.3"), p("Deposition rate (remainder)", "Å/s", "1.5"),
      p("Film thickness", "nm", "100"),
    ],
    notes: "Same two-stage rate as Cu.",
  },
  {
    name: "Evaporate LiF", processName: "Thermal evaporation", source: VACUUM,
    parameters: [p("Deposition rate", "Å/s", "0.2"), p("Film thickness", "nm", "1")],
    notes: "热蒸镀 table, row 5.",
  },
  {
    name: "Evaporate MgF2", processName: "Thermal evaporation", source: VACUUM,
    parameters: [p("Deposition rate", "Å/s", "0.5"), p("Film thickness", "nm", "120")],
    notes: "热蒸镀 table, row 6 — antireflection layer.",
  },
  // --- sputtering ---
  {
    name: "Sputter IZO", processName: "Sputter PVD", source: VACUUM,
    parameters: [
      p("Base pressure", "Pa", "5E-4"), p("Stage rotation", "r/min", "5"), p("Heating", "°C", "60"),
      p("Pre-sputter power", "W", "100"), p("Pre-sputter time", "s", "300"),
      p("Gas", "", "Ar"), p("Gas flow", "sccm", "30"), p("Process pressure", "Pa", "0.1"),
      p("Process power 1", "W", "150"), p("Cycles 1", "cycle", "5"),
      p("Process power 2", "W", "200"), p("Cycles 2", "cycle", "20"),
      p("Power supply", "", "RF"),
    ],
    confidence:
      "The document reads '工艺功率1150W / 循环15cycle / 工艺功率2200W / 循环220cycle'. Transcribed as a TWO-STAGE recipe (power 1 = 150 W for 5 cycles, power 2 = 200 W for 20 cycles) rather than 1150 W / 15 cycles. Please confirm — this is an interpretation, not a literal reading.",
  },
  {
    name: "Sputter ITO", processName: "Sputter PVD", source: VACUUM,
    parameters: [
      p("Heating", "", "none"), p("Gas", "", "Ar"), p("Gas flow", "sccm", "20"),
      p("Process pressure", "Pa", "0.2"), p("Process power 1", "W", "250"), p("Cycles 1", "cycle", "16"),
    ],
    confidence: "Same stage-number ambiguity: '工艺功率1250W 循环116cycle' read as power 1 = 250 W, cycles 1 = 16.",
  },
  {
    name: "Sputter NiOx", processName: "Sputter PVD", source: VACUUM,
    parameters: [
      p("Gas", "", "Ar / O2"), p("Ar flow", "sccm", "50"), p("O2 flow", "sccm", "5"),
      p("Process pressure", "Pa", "0.35"), p("Process power 1", "W", "200"), p("Cycles 1", "cycle", "18"),
    ],
    confidence: "Same stage-number ambiguity: '工艺功率1200W 循环118cycle' read as power 1 = 200 W, cycles 1 = 18.",
  },
];

// Laser scribing P1–P4 for the large-area module.
const LASER_SRC = "模组和器件设计/大面积模组激光划线参数.xlsx";
const LASER = [
  { n: "P1", laser: "红光 (red)", speed: "400", accel: "3000", power: "0.45", freq: "100", focus: "76", width: "35 µm", pitchNote: "/" },
  { n: "P2", laser: "绿光 (green)", speed: "1200", accel: "3000", power: "0.4", freq: "600", focus: "42.4", width: "55 µm", pitchNote: "P2–P1 spacing 0.1" },
  { n: "P3", laser: "绿光 (green)", speed: "1200", accel: "4000", power: "0.5", freq: "100", focus: "42.4", width: "50 µm", pitchNote: "P3–P2 spacing 0.1" },
  { n: "P4", laser: "红光 (red)", speed: "8", accel: "1000", power: "0.6", freq: "1000", focus: "76", width: "10 mm", pitchNote: "/" },
];
for (const l of LASER) {
  PRESETS.push({
    name: `Laser scribe ${l.n} — 100×100 mm module`,
    processName: "Laser scribing",
    source: LASER_SRC,
    parameters: [
      p("Laser", "", l.laser), p("Processing speed", "mm/s", l.speed), p("Acceleration", "mm/s²", l.accel),
      p("Power", "", l.power), p("Frequency", "kHz", l.freq), p("Duty cycle", "", "0.3"),
      p("Camera focus", "", "60.635"), p("Laser focus", "", l.focus), p("Line width", "", l.width),
      p("Line spacing", "", l.pitchNote), p("Glass size", "mm", "100×100"), p("Glass thickness", "mm", "3.2"),
      p("Sub-cells", "count", "11"), p("Scribe pitch", "mm", "7.45"),
    ],
    notes: `${l.n} scribe for the 100×100 mm, 11 sub-cell module.`,
    confidence:
      l.n === "P4"
        ? "Power is given as a bare 0.45–0.6 with no unit (likely a fraction of full power) — confirm before use. P4's line width is 10 mm, not µm like P1–P3, consistent with an edge-deletion pass."
        : "Power is given as a bare 0.45–0.6 with no unit (likely a fraction of full power) — confirm before use.",
  });
}

// --------------------------------------------------------------- staging

(async () => {
  const dry = process.argv.includes("--dry");
  const orgSlug = process.env.INGEST_ORG_SLUG || "pheno";
  const org = await db.organization.findFirstOrThrow({ where: { slug: orgSlug } });
  const items = [];

  for (const m of MSDS) {
    items.push({
      kind: "MATERIAL", title: m.name, sourceFile: `${SRC}/${m.source}`,
      confidence: m.confidence ?? "Read from the supplier datasheet with pdftotext; CAS, molecular weight and formula are as printed.",
      payload: {
        name: m.name, category: m.category ?? "SOLVENT", composition: m.composition, smiles: "",
        casNumber: m.casNumber, molecularWeight: m.molecularWeight, purity: "",
        supplier: m.supplier, lot: m.lot, properties: m.properties, notes: "",
      },
    });
  }
  for (const s of SUBSTRATES) {
    items.push({
      kind: "MATERIAL", title: s.name, sourceFile: `${SRC}/TCO基底/`,
      confidence: s.confidence ?? "From the supplier specification table in 小面积TCO玻璃基底-优选内部资料(2024).docx.",
      payload: {
        name: s.name, category: "OTHER", composition: "", smiles: "", casNumber: "",
        molecularWeight: "", purity: "", supplier: s.supplier, lot: "",
        properties: s.properties, notes: "",
      },
    });
  }
  for (const e of EQUIPMENT) {
    items.push({
      kind: "EQUIPMENT", title: e.name, sourceFile: `${SRC}/${e.source}`,
      confidence: e.confidence ?? "Specifications read from the supplier document with pdftotext.",
      payload: {
        name: e.name, make: e.make, model: e.model, assetTag: "",
        processName: e.processName, locationName: e.locationName,
        parameters: e.parameters, notes: e.notes,
      },
    });
  }
  for (const en of ENVIRONMENTS) {
    items.push({
      kind: "ENVIRONMENT", title: en.name, sourceFile: `${SRC}/${en.source}`,
      confidence: en.confidence ?? "Conditions as stated in 实验环境.docx.",
      payload: { name: en.name, conditions: en.conditions, notes: en.notes },
    });
  }
  for (const pr of PRESETS) {
    items.push({
      kind: "PRESET", title: `${pr.name} (${pr.processName})`, sourceFile: `${SRC}/${pr.source}`,
      confidence: pr.confidence ?? "Parameters transcribed as written in the source document.",
      payload: { name: pr.name, processName: pr.processName, parameters: pr.parameters, notes: pr.notes ?? "" },
    });
  }

  if (dry) {
    console.log(JSON.stringify(items, null, 2));
    console.log(`\n${items.length} item(s) would be staged.`);
    await db.$disconnect();
    return;
  }

  for (const it of items) {
    await db.ingestItem.create({
      data: {
        organizationId: org.id, kind: it.kind, title: it.title,
        sourceFile: it.sourceFile, confidence: it.confidence, payload: it.payload,
      },
    });
  }
  const byKind = items.reduce((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
  console.log(`staged ${items.length} item(s) for review at /ingest (org: ${org.name})`);
  console.log(" ", JSON.stringify(byKind));
  await db.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
