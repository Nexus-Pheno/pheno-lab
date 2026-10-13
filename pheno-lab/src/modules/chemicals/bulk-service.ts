import "server-only";

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import {
  renderMolecule,
  InvalidSmilesError,
} from "@/infrastructure/chemistry/renderer";
import {
  readSamWorkbook,
  readSamTemplate,
  MAX_CHEMICAL_FILE_BYTES,
} from "@/infrastructure/chemistry/workbook";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { requireChemicalAccess } from "./query";
import {
  registrationTarget,
  registrationSelect,
  type RegistrationMaterial,
} from "./registration";
import { chemicalRowDigest } from "./query";
import { ensureChemicalCategory } from "./category-service";
import type { ChemicalImportPreview, ChemicalImportRow } from "./bulk-types";
import {
  ChemicalImportConflict,
  chemicalImportReviewSchema,
  applyChemicalImportReview,
  chemicalReviewDigest,
  storedChemicalReviewDigest,
} from "./bulk-review";

export { ChemicalWorkbookError } from "@/infrastructure/chemistry/workbook";
export { MAX_CHEMICAL_FILE_BYTES } from "@/infrastructure/chemistry/workbook";
export {
  ChemicalImportConflict,
  MAX_CHEMICAL_REVIEW_BYTES,
} from "./bulk-review";
const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  category: z.string().trim().min(1).max(100).default("SAM"),
  review: chemicalImportReviewSchema.default({ edits: [], excludedRows: [] }),
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (bytes) => bytes.length > 0 && bytes.length <= MAX_CHEMICAL_FILE_BYTES,
    ),
});
const commitSchema = fileSchema.extend({
  batchId: z.uuid(),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedReviewDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const digest = (bytes: Uint8Array | string) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export async function chemicalImportTemplate(actor: Actor) {
  await requireChemicalAccess(actor);
  return readSamTemplate();
}

const DATABASE_CHUNK_SIZE = 200;

/** Keep lookup parameters bounded and resolve names without a quadratic scan. */
async function registrationGroups(
  client: Pick<Prisma.TransactionClient, "material">,
  organizationId: string,
  names: string[],
) {
  const unique = [
    ...new Map(
      names.filter(Boolean).map((name) => [name.toLowerCase(), name]),
    ).values(),
  ];
  const groups = new Map<string, RegistrationMaterial[]>();
  for (let offset = 0; offset < unique.length; offset += DATABASE_CHUNK_SIZE) {
    const matches = await client.material.findMany({
      where: {
        organizationId,
        OR: unique.slice(offset, offset + DATABASE_CHUNK_SIZE).map((name) => ({
          name: { equals: name, mode: "insensitive" as const },
        })),
      },
      select: registrationSelect,
    });
    for (const match of matches) {
      const key = match.name.toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(match);
      groups.set(key, group);
    }
  }
  return groups;
}

async function prepare(actor: Actor, input: z.infer<typeof fileSchema>) {
  if (
    !["SAM", "ADDITIVE", "SOLVENT", "OTHER"].includes(input.category) &&
    !(await db.materialCategoryDef.count({
      where: { organizationId: actor.org, code: input.category },
    }))
  )
    throw new ChemicalImportConflict(
      "Choose a category from this organization.",
    );
  const entries = applyChemicalImportReview(
    await readSamWorkbook(input.bytes, input.filename),
    input.review,
  );
  const rows: ChemicalImportRow[] = [];
  const molecules: Awaited<ReturnType<typeof renderMolecule>>[] = [];
  const rendered = new Map<
    string,
    Awaited<ReturnType<typeof renderMolecule>>
  >();
  const names = new Map<string, number[]>();
  for (const entry of entries) {
    const [nameValue, smilesValue] = entry.cells;
    const name = typeof nameValue === "string" ? nameValue.trim() : "";
    const smiles = typeof smilesValue === "string" ? smilesValue.trim() : "";
    const row: ChemicalImportRow = {
      row: entry.row,
      name: name.slice(0, 200),
      smiles: smiles.slice(0, 4000),
      issues: [],
      preview: null,
      linksExisting: false,
    };
    if (!name || name.length > 200) row.issues.push("name");
    if (!smiles || smiles.length > 4000) row.issues.push("smiles");
    if (
      (nameValue !== null && typeof nameValue !== "string") ||
      (smilesValue !== null && typeof smilesValue !== "string")
    )
      row.issues.push("text");
    if (entry.cells.slice(2).some((value) => value !== null && value !== ""))
      row.issues.push("columns");
    const indices = names.get(name.toLowerCase()) ?? [];
    indices.push(rows.length);
    names.set(name.toLowerCase(), indices);
    rows.push(row);
    if (!row.issues.length) {
      try {
        const molecule = rendered.get(smiles) ?? (await renderMolecule(smiles));
        rendered.set(smiles, molecule);
        molecules.push(molecule);
        row.preview = {
          svg: molecule.svg,
          canonicalSmiles: molecule.canonicalSmiles,
          engineVersion: molecule.engineVersion,
          atomCount: molecule.atomCount,
        };
      } catch (error) {
        if (!(error instanceof InvalidSmilesError)) throw error;
        row.issues.push("invalidSmiles");
      }
    }
  }
  for (const indices of names.values())
    if (indices.length > 1)
      for (const index of indices) rows[index].issues.push("duplicate");
  const existing = await registrationGroups(
    db,
    actor.org,
    rows.map((row) => row.name),
  );
  const targets: (RegistrationMaterial | null)[] = [];
  for (const row of rows) {
    const target = registrationTarget(
      existing.get(row.name.toLowerCase()) ?? [],
      row.name,
    );
    if (target.issue) row.issues.push(target.issue);
    row.linksExisting = !!target.material;
    targets.push(target.material);
  }
  return {
    preview: {
      rows,
      fileSha256: digest(input.bytes),
      reviewSha256: chemicalReviewDigest(
        digest(input.bytes),
        input.category,
        input.review,
      ),
      category: input.category,
      valid: rows.length > 0 && rows.every((row) => row.issues.length === 0),
    } satisfies ChemicalImportPreview,
    molecules,
    targets,
  };
}

export async function previewChemicalImport(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  return (await prepare(actor, fileSchema.parse(raw))).preview;
}

async function cleanup(keys: string[]) {
  for (const key of keys) {
    try {
      const [structures, sources] = await Promise.all([
        db.materialChemistry.count({ where: { structurePath: key } }),
        db.chemicalImportBatch.count({ where: { sourcePath: key } }),
      ]);
      if (!structures && !sources) await objectStorage().delete(key);
    } catch {
      /* Preserve the object if a commit or reference cannot be confirmed. */
    }
  }
}

async function putVerified(key: string, body: Uint8Array, contentType: string) {
  await objectStorage().put({
    key,
    body: Buffer.from(body),
    contentType,
    sha256: digest(body),
  });
  const stored = await objectStorage().get(key);
  if (
    !stored ||
    stored.byteLength !== body.byteLength ||
    digest(stored) !== digest(body)
  )
    throw new Error("Stored file verification failed.");
}

function batchCategory(manifest: unknown) {
  if (
    Array.isArray(manifest) &&
    manifest[0] &&
    typeof manifest[0].category === "string"
  )
    return manifest[0].category;
  return "SAM"; // Existing two-column SAM batches remain replay-compatible.
}

export async function importChemicalWorkbook(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const input = commitSchema.parse(raw);
  const fileSha256 = digest(input.bytes);
  const reviewSha256 = chemicalReviewDigest(
    fileSha256,
    input.category,
    input.review,
  );
  if (fileSha256 !== input.expectedDigest)
    throw new ChemicalImportConflict("Workbook changed. Validate it again.");
  if (
    (input.expectedReviewDigest &&
      input.expectedReviewDigest !== reviewSha256) ||
    (!input.expectedReviewDigest &&
      (input.review.edits.length || input.review.excludedRows.length))
  )
    throw new ChemicalImportConflict("The review changed. Validate it again.");
  const previous = await db.chemicalImportBatch.findFirst({
    where: { id: input.batchId, organizationId: actor.org },
  });
  if (previous) {
    if (
      previous.sourceSha256 !== fileSha256 ||
      batchCategory(previous.manifest) !== input.category ||
      storedChemicalReviewDigest(
        previous.manifest,
        fileSha256,
        input.category,
      ) !== reviewSha256
    )
      throw new ChemicalImportConflict("Batch contains a different workbook.");
    return {
      batchId: previous.id,
      created: 0,
      total: previous.rowCount,
      replayed: true,
    };
  }
  const { preview, molecules, targets } = await prepare(actor, input);
  if (!preview.valid)
    throw new ChemicalImportConflict(
      "Review workbook errors before importing.",
    );
  const prefix = `organizations/${actor.org}/chemicals/bulk/${input.batchId}/`;
  const keys: string[] = [];
  const sourcePath = `${prefix}${crypto.randomUUID()}.xlsx`;
  const materialIds: string[] = preview.rows.map(() => crypto.randomUUID());
  const structurePaths = preview.rows.map(
    () => `${prefix}${crypto.randomUUID()}.svg`,
  );
  try {
    keys.push(sourcePath);
    await putVerified(
      sourcePath,
      input.bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // Bounded uploads, all verified before opening the database transaction.
    for (let offset = 0; offset < molecules.length; offset += 4) {
      const outcomes = await Promise.allSettled(
        molecules.slice(offset, offset + 4).map(async (molecule, index) => {
          const key = structurePaths[offset + index];
          keys.push(key);
          await putVerified(key, Buffer.from(molecule.svg), "image/svg+xml");
        }),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-save:${actor.org}`},0))`;
        await requireChemicalAccess(actor, tx);
        const repeated = await tx.chemicalImportBatch.findFirst({
          where: { id: input.batchId, organizationId: actor.org },
        });
        if (repeated) {
          if (
            repeated.sourceSha256 !== fileSha256 ||
            batchCategory(repeated.manifest) !== input.category ||
            storedChemicalReviewDigest(
              repeated.manifest,
              fileSha256,
              input.category,
            ) !== reviewSha256
          )
            throw new ChemicalImportConflict(
              "Batch contains a different workbook.",
            );
          return {
            batchId: repeated.id,
            created: 0,
            total: repeated.rowCount,
            replayed: true,
          };
        }
        const current = await registrationGroups(
          tx,
          actor.org,
          preview.rows.map((row) => row.name),
        );
        const finalTargets = preview.rows.map((row, index) => {
          const target = registrationTarget(
            current.get(row.name.toLowerCase()) ?? [],
            row.name,
          );
          if (target.issue)
            throw new ChemicalImportConflict(
              "Material names changed. Validate the workbook again.",
            );
          const before = targets[index];
          if (
            before &&
            (!target.material ||
              before.id !== target.material.id ||
              chemicalRowDigest(before) !==
                chemicalRowDigest(target.material) ||
              (before.chemistry?.version ?? 0) !==
                (target.material.chemistry?.version ?? 0))
          )
            throw new ChemicalImportConflict(
              "Material changed. Validate the workbook again.",
            );
          if (target.material) materialIds[index] = target.material.id;
          return target.material;
        });
        const linked = finalTargets.filter(Boolean).length;
        await tx.chemicalImportBatch.create({
          data: {
            id: input.batchId,
            organizationId: actor.org,
            createdById: actor.uid,
            sourcePath,
            sourceSha256: fileSha256,
            sourceBytes: input.bytes.byteLength,
            rowCount: preview.rows.length,
            manifest: preview.rows.map((row, index) => ({
              row: row.row,
              materialId: materialIds[index],
              category: input.category,
              inputSha256: molecules[index].inputSha256,
              structureSha256: molecules[index].structureSha256,
              inputName: row.name,
              inputSmiles: row.smiles,
              ...(index === 0
                ? {
                    review: {
                      version: 1,
                      sha256: reviewSha256,
                      ...input.review,
                    },
                  }
                : {}),
            })),
          },
        });
        const additions: Prisma.MaterialCreateManyInput[] = [];
        const newDefinitions: Prisma.MaterialChemistryCreateManyInput[] = [];
        for (const [index, row] of preview.rows.entries()) {
          const molecule = molecules[index];
          const existing = finalTargets[index];
          if (existing)
            await tx.material.update({
              where: { id: existing.id },
              data: { category: input.category, smiles: row.smiles },
            });
          else
            additions.push({
              id: materialIds[index],
              organizationId: actor.org,
              name: row.name,
              category: input.category,
              smiles: row.smiles,
            });
          const evidence = {
            materialId: materialIds[index],
            inSamRegistry: true,
            importBatchId: input.batchId,
            requestId: crypto.randomUUID(),
            canonicalSmiles: molecule.canonicalSmiles,
            inputSha256: molecule.inputSha256,
            structurePath: structurePaths[index],
            structureSha256: molecule.structureSha256,
            structureBytes: molecule.structureBytes,
            engineVersion: molecule.engineVersion,
            atomCount: molecule.atomCount,
            version: (existing?.chemistry?.version ?? 0) + 1,
            generatedAt: new Date(),
          };
          if (existing?.chemistry)
            await tx.materialChemistry.update({
              where: { materialId: materialIds[index] },
              data: evidence,
            });
          else newDefinitions.push(evidence);
        }
        for (
          let offset = 0;
          offset < additions.length;
          offset += DATABASE_CHUNK_SIZE
        ) {
          await tx.material.createMany({
            data: additions.slice(offset, offset + DATABASE_CHUNK_SIZE),
          });
        }
        for (
          let offset = 0;
          offset < newDefinitions.length;
          offset += DATABASE_CHUNK_SIZE
        ) {
          await tx.materialChemistry.createMany({
            data: newDefinitions.slice(offset, offset + DATABASE_CHUNK_SIZE),
          });
        }
        await ensureChemicalCategory(tx, actor, input.category);
        await recordUserAudit(tx, {
          actor,
          action: "chemistry.bulk.created",
          entityType: "ChemicalImportBatch",
          entityId: input.batchId,
          requestId: input.batchId,
          changes: {
            registered: preview.rows.length,
            created: preview.rows.length - linked,
            linked,
            category: input.category,
            edited: input.review.edits.length,
            excluded: input.review.excludedRows.length,
          },
          metadata: { fileSha256, sourceBytes: input.bytes.byteLength },
        });
        return {
          batchId: input.batchId,
          created: preview.rows.length - linked,
          linked,
          total: preview.rows.length,
          replayed: false,
        };
      },
      { timeout: 30000 },
    );
    if (result.replayed) await cleanup(keys);
    return result;
  } catch (error) {
    await cleanup(keys);
    throw error;
  }
}

export async function readImportedWorkbook(actor: Actor, rawId: unknown) {
  await requireChemicalAccess(actor);
  const id = z.uuid().parse(rawId);
  const batch = await db.chemicalImportBatch.findFirst({
    where: { id, organizationId: actor.org },
  });
  if (
    !batch ||
    !batch.sourcePath.startsWith(
      `organizations/${actor.org}/chemicals/bulk/${id}/`,
    )
  )
    return null;
  const body = await objectStorage().get(batch.sourcePath);
  if (
    !body ||
    body.byteLength !== batch.sourceBytes ||
    digest(body) !== batch.sourceSha256
  )
    return null;
  return body;
}
