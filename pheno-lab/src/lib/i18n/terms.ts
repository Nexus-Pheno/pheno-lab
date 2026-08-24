import type { Lang } from "./dict";

// Display-time localization for lab vocabulary (process, parameter,
// environment and characterization names seeded in English). Applied only to
// read-only displays — never to editable inputs, so stored data is untouched.
// Unknown terms pass through unchanged.

const TERM_ZH: Record<string, string> = {
  // Processes
  "Cleaning / washing": "清洗",
  "Surface treatment": "表面处理",
  "Spin coating": "旋涂",
  "Blade coating": "刮涂",
  "Slot-die coating": "狭缝涂布",
  "Spray coating": "喷涂",
  "Inkjet printing": "喷墨打印",
  "Thermal anneal": "热退火",
  "Sputter PVD": "溅射镀膜 (PVD)",
  "Thermal evaporation": "热蒸发",
  "ALD": "原子层沉积 (ALD)",
  "Laser scribing": "激光刻线",
  "Encapsulation": "封装",
  // Characterization
  "J-V — solar simulation": "J-V — 太阳光模拟",
  "EQE": "外量子效率 (EQE)",
  "SEM": "扫描电镜 (SEM)",
  "SEM — cross-section": "扫描电镜 — 截面",
  "Ellipsometry": "椭偏仪",
  "Ellipsometry — thickness": "椭偏仪 — 厚度",
  "XRD": "X 射线衍射 (XRD)",
  "Photoluminescence": "光致发光 (PL)",
  "Profilometry": "台阶仪",
  // Seeded step names
  "Glass washing": "玻璃清洗",
  "UV-Ozone treatment": "UV-臭氧处理",
  "Blade coat — SAM": "刮涂 — SAM",
  "Thermal anneal — SAM": "热退火 — SAM",
  "Slot-die — perovskite": "狭缝涂布 — 钙钛矿",
  "Thermal anneal — perovskite": "热退火 — 钙钛矿",
  "Evaporation — C60 / BCP": "蒸镀 — C60 / BCP",
  "Sputter — ITO electrode": "溅射 — ITO 电极",
  // Environments
  "Ambient": "大气环境",
  "Clean room": "洁净室",
  "Glovebox N₂": "氮气手套箱",
  "Glovebox N2": "氮气手套箱",
  "Vacuum": "真空",
  // Environment condition keys
  "Relative humidity (%)": "相对湿度 (%)",
  "Temperature (°C)": "温度 (°C)",
  "Particle count (class)": "洁净度等级",
  "Pressure (mbar)": "压强 (mbar)",
  "O₂": "O₂",
  "H₂O": "H₂O",
  // Common parameter names (seed defaults across processes)
  "Solvent sequence": "溶剂顺序",
  "Time per solvent": "每种溶剂时间",
  "Time per solvent (min)": "每种溶剂时间 (min)",
  "Bath temperature": "水浴温度",
  "Bath temperature (°C)": "水浴温度 (°C)",
  "Treatment type": "处理方式",
  "Duration": "时长",
  "Duration (min)": "时长 (min)",
  "Gas": "气体",
  "Temperature": "温度",
  "Ramp rate": "升温速率",
  "Spin speed": "转速",
  "Spin time": "旋涂时间",
  "Acceleration": "加速度",
  "Dispense volume": "分液量",
  "Coating speed": "涂布速度",
  "Blade gap": "刮刀间隙",
  "Coating gap": "涂布间隙",
  "Flow rate": "流量",
  "Substrate temperature": "基底温度",
  "Nozzle temperature": "喷头温度",
  "Drop spacing": "液滴间距",
  "Power": "功率",
  "Base pressure": "本底真空",
  "Working pressure": "工作气压",
  "Deposition rate": "沉积速率",
  "Target": "靶材",
  "Thickness": "厚度",
  "Thickness (nm)": "厚度 (nm)",
  "Rate": "速率",
  "Source temperature": "源温度",
  "Precursor A": "前驱体 A",
  "Precursor B": "前驱体 B",
  "Cycles": "循环次数",
  "Pulse time": "脉冲时间",
  "Purge time": "吹扫时间",
  "Laser power": "激光功率",
  "Scribe speed": "刻线速度",
  "Wavelength": "波长",
  "Pattern": "图形",
  "Adhesive": "胶粘剂",
  "Cure time": "固化时间",
  "UV dose": "UV 剂量",
  "Scan direction": "扫描方向",
  "Scan rate": "扫描速率",
  "Light intensity": "光强",
  "Cell area": "电池面积",
  "Irradiance": "辐照度",
  "Voltage range": "电压范围",
  "Voltage step": "电压步长",
  "Accelerating voltage": "加速电压",
  "Magnification": "放大倍数",
  "Angle of incidence": "入射角",
  "Wavelength range": "波长范围",
  "Integration time": "积分时间",
  "Excitation wavelength": "激发波长",
  "2θ range": "2θ 范围",
  "Step size": "步长",
};

export function localizeTerm(lang: Lang, s: string | null | undefined): string {
  if (!s) return s ?? "";
  if (lang !== "zh") return s;
  const hit = TERM_ZH[s] ?? TERM_ZH[s.trim()];
  if (hit) return hit;
  // Units in parentheses often trail dictionary terms: "Duration (min)".
  const m = s.match(/^(.*?)\s*(\([^)]*\))$/);
  if (m && TERM_ZH[m[1].trim()]) return `${TERM_ZH[m[1].trim()]} ${m[2]}`;
  return s;
}
