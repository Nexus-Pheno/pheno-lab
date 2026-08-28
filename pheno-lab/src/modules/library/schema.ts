import { z } from "zod";

const idSchema = z.string().min(1).max(128);
const shortText = z.string().trim().max(500);

export const paramDefSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().max(60),
  defaultValue: z.string().max(500),
});

export const processCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["PROCESSING", "CHARACTERIZATION"]),
  icon: z.string().trim().min(1).max(80),
});

export const processUpdateSchema = z.object({
  id: idSchema,
  data: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      icon: z.string().trim().min(1).max(80).optional(),
      parameters: z.array(paramDefSchema).max(200).optional(),
      defaultLayer: z.string().trim().max(120).optional(),
      archived: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, "No changes supplied."),
});

export const locationCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const locationUpdateSchema = z.object({
  id: idSchema,
  data: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      archived: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, "No changes supplied."),
});

const equipmentFields = z.object({
  processId: idSchema,
  name: z.string().trim().min(1).max(200),
  nickname: shortText,
  make: shortText,
  model: shortText,
  assetTag: shortText,
  locationId: idSchema.nullable(),
  photoPath: z.string().max(1000),
  parameters: z.array(paramDefSchema).max(200),
});

export const equipmentCreateSchema = equipmentFields;
export const equipmentUpdateSchema = z.object({
  id: idSchema,
  data: equipmentFields.partial().extend({ archived: z.boolean().optional() }),
});

export const environmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  conditions: z.array(paramDefSchema).max(200),
  // Detail about the enclosure itself — make, model, chambers. Distinct from
  // `conditions`, which are the readings an operator records per run.
  notes: z.string().max(50_000).default(""),
});

export const environmentUpdateSchema = z.object({
  id: idSchema,
  data: environmentCreateSchema.partial().extend({
    archived: z.boolean().optional(),
  }),
});

export const libraryMaterialCreateSchema = z.object({
  processId: idSchema.nullable(),
  name: z.string().trim().min(1).max(200),
  composition: shortText,
  supplier: shortText,
  lot: shortText,
});

export const libraryMaterialUpdateSchema = z.object({
  id: idSchema,
  data: libraryMaterialCreateSchema.partial().extend({
    archived: z.boolean().optional(),
  }),
});

export const materialCardSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(120),
  composition: shortText,
  smiles: z.string().trim().max(4000),
  casNumber: shortText,
  molecularWeight: shortText,
  purity: shortText,
  supplier: shortText,
  lot: shortText,
  properties: z.record(z.string(), z.string().max(4000)),
  notes: z.string().max(20_000),
  processId: idSchema.nullable(),
});

export const recipePayloadSchema = z.object({
  components: z
    .array(
      z.object({
        material: z.string().trim().max(500),
        amount: z.string().max(500),
        role: z.string().max(500).optional(),
      }),
    )
    .max(500),
  solvents: z.string().max(4000),
  concentration: z.string().max(1000),
  procedure: z.string().max(20_000),
  composition: z.string().max(4000).optional(),
  bandGap: z.string().max(500).optional(),
  notes: z.string().max(20_000).optional(),
});

export const recipeSaveSchema = z.object({
  id: idSchema.nullable(),
  data: z.object({
    name: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(2000),
    payload: recipePayloadSchema,
  }),
});

export const permissionSchema = z.enum([
  "materialAdmin",
  "equipmentAdmin",
  "facilityAdmin",
  "recipeAccess",
]);

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nameZh: z.string().trim().max(200),
});

export const categoryRenameSchema = categoryCreateSchema.extend({
  id: idSchema,
});

export const categoryDeleteSchema = z.object({
  id: idSchema,
  moveToCode: z.string().trim().min(1).max(120),
});

export const categoryMoveSchema = z.object({
  id: idSchema,
  direction: z.enum(["up", "down"]),
});
