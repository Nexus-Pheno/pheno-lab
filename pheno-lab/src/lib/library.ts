// Processes, equipment, materials, environments, locations, and presets all
// live in the database, scoped per organization. This module holds shared
// shapes and display metadata only.

// Parameter/condition definition shape stored on Equipment.parameters and
// LabEnvironment.conditions.
export type ParamDef = { name: string; unit: string; defaultValue: string };

// Experiment.metadata.testPlan — the variable plan driving samples and the
// varied process steps. Groups are global (rows); each variable (column)
// assigns a value per group. Variables can be process parameters or materials.
export type TestPlanGroup = { label: string; samples: number; isControl: boolean };
export type TestPlanVariable = {
  kind: "parameter" | "material";
  processId: string;
  equipmentId?: string; // the specific machine used to realize this variable
  layer?: string; // DeviceLayer.code the variable acts on
  parameter: string; // parameter name, or the material slot name for kind=material
  unit: string;
  values: Record<string, string>; // group label -> value
};
export type TestPlanSubstrates = { count: number; materialName?: string };
export type TestPlan = {
  groups: TestPlanGroup[];
  variables: TestPlanVariable[];
  /** Substrate batch prepared up front; chips are dragged between groups. */
  substrates?: TestPlanSubstrates;
  /** sample code (S1) → group label, EXTRA or ERROR */
  assignments?: Record<string, string>;
};

export const STATUS_META: Record<string, { label: string; tone: "muted" | "warning" | "brand" | "danger" }> = {
  DRAFT: { label: "Draft", tone: "warning" },
  IN_LAB: { label: "In lab", tone: "brand" },
  REVIEW: { label: "In review", tone: "warning" },
  COMPLETE: { label: "Complete", tone: "muted" },
  ARCHIVED: { label: "Archived", tone: "muted" },
};

export const ROLE_META: Record<string, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  TECHNICIAN: "Technician",
};

// Icon choices offered when creating a process.
export const PROCESS_ICONS = [
  "Wrench", "FlaskConical", "Sun", "Disc", "Slice", "AlignVerticalJustifyEnd", "SprayCan",
  "Printer", "Flame", "Box", "ArrowUpFromLine", "Layers", "Zap", "Package", "SunMedium",
  "Activity", "Search", "Waves", "BarChart3", "Lightbulb", "TrendingUp", "Microscope", "Droplets",
];

export const GROUP_LABELS = [..."ABCDEFGHIJKLMNOPQRST"]; // up to 20 variable groups
