import "server-only";

import crypto from "node:crypto";
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
import { ensureChemicalCategory } from "./category-service";
import type { ChemicalImportPreview, ChemicalImportRow } from "./bulk-types";

export { ChemicalWorkbookError } from "@/infrastructure/chemistry/workbook";
export { MAX_CHEMICAL_FILE_BYTES } from "@/infrastructure/chemistry/workbook";
const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (bytes) => bytes.length > 0 && bytes.length <= MAX_CHEMICAL_FILE_BYTES,
    ),
});
const commitSchema = fileSchema.extend({
  batchId: z.uuid(),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export class ChemicalImportConflict extends Error {}
const digest = (bytes: Uint8Array | string) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export async function chemicalImportTemplate(actor: Actor) {
  await requireChemicalAccess(actor);
  return readSamTemplate();
}

async function prepare(actor: Actor, input: z.infer<typeof fileSchema>) {
  const entries = await readSamWorkbook(input.bytes, input.filename);
  const rows: ChemicalImportRow[] = [];
  const molecules: Awaited<ReturnType<typeof renderMolecule>>[] = [];
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
        const molecule = await renderMolecule(smiles);
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
  const existing = await db.material.findMany({
    where: {
      organizationId: actor.org,
      OR: rows
        .filter((row) => row.name)
        .map((row) => ({
          name: { equals: row.name, mode: "insensitive" as const },
        })),
    },
    select: { name: true },
  });
  for (const row of rows)
    if (
      existing.some(
        (material) => material.name.toLowerCase() === row.name.toLowerCase(),
      )
    )
      row.issues.push("exists");
  return {
    preview: {
      rows,
      fileSha256: digest(input.bytes),
      valid: rows.every((row) => row.issues.length === 0),
    } satisfies ChemicalImportPreview,
    molecules,
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

export async function importChemicalWorkbook(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const input = commitSchema.parse(raw);
  const fileSha256 = digest(input.bytes);
  if (fileSha256 !== input.expectedDigest)
    throw new ChemicalImportConflict("Workbook changed. Validate it again.");
  const previous = await db.chemicalImportBatch.findFirst({
    where: { id: input.batchId, organizationId: actor.org },
  });
  if (previous) {
    if (previous.sourceSha256 !== fileSha256)
      throw new ChemicalImportConflict("Batch contains a different workbook.");
    return {
      batchId: previous.id,
      created: 0,
      total: previous.rowCount,
      replayed: true,
    };
  }
  const { preview, molecules } = await prepare(actor, input);
  if (!preview.valid)
    throw new ChemicalImportConflict(
      "Review workbook errors before importing.",
    );
  const prefix = `organizations/${actor.org}/chemicals/bulk/${input.batchId}/`;
  const keys: string[] = [];
  const sourcePath = `${prefix}${crypto.randomUUID()}.xlsx`;
  const materialIds = preview.rows.map(() => crypto.randomUUID());
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
          if (repeated.sourceSha256 !== fileSha256)
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
        const duplicates = await tx.material.count({
          where: {
            organizationId: actor.org,
            OR: preview.rows.map((row) => ({
              name: { equals: row.name, mode: "insensitive" as const },
            })),
          },
        });
        if (duplicates)
          throw new ChemicalImportConflict(
            "Material names changed. Validate the workbook again.",
          );
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
              inputSha256: molecules[index].inputSha256,
              structureSha256: molecules[index].structureSha256,
            })),
          },
        });
        for (const [index, row] of preview.rows.entries()) {
          const molecule = molecules[index];
          await tx.material.create({
            data: {
              id: materialIds[index],
              organizationId: actor.org,
              name: row.name,
              category: "SAM",
              smiles: row.smiles,
              chemistry: {
                create: {
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
                },
              },
            },
          });
        }
        await ensureChemicalCategory(tx, actor, "SAM");
        await recordUserAudit(tx, {
          actor,
          action: "chemistry.bulk.created",
          entityType: "ChemicalImportBatch",
          entityId: input.batchId,
          requestId: input.batchId,
          changes: { created: preview.rows.length, category: "SAM" },
          metadata: { fileSha256, sourceBytes: input.bytes.byteLength },
        });
        return {
          batchId: input.batchId,
          created: preview.rows.length,
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
