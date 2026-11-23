import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Reader } from "./access";
import { AuthorizationError } from "@/modules/authorization/policy";
import {
  experimentVisibilityScope,
  measurementVisibilityScope,
} from "@/modules/authorization/scope";
import {
  publicMaterialSelect,
  redactSmilesJson,
} from "@/modules/library/material-visibility";
import {
  requireChemicalAccess,
  chemicalSelect,
  chemicalAnalysisDefinition,
} from "@/modules/chemicals/query";
import { createHash } from "node:crypto";
import {
  reportMetadataSelect,
  requireReportAccess,
} from "@/modules/reports/query";
import { readLabReportContent } from "@/modules/reports/service";
import { getResultsExperiment } from "@/modules/experiments/query";
import { buildExperimentEvidence } from "@/modules/experiments/result-evidence";
import { readObject } from "@/modules/files/service";
import { recordUserAudit } from "@/modules/audit/writer";

import { listPublishedStudies } from "@/modules/film-studies/query";
import { findStudyFile, readStudyPart } from "@/modules/film-studies/service";
import { partCount } from "@/modules/film-studies/schema";
const resources = [
  "filmStudies",
  "projects",
  "experiments",
  "samples",
  "steps",
  "characterizations",
  "runs",
  "executions",
  "results",
  "scans",
  "materials",
  "recipes",
  "processes",
  "equipment",
  "environments",
  "comments",
  "attachments",
  "analyses",
  "layers",
  "categories",
  "presets",
  "instruments",
  "originals",
  "testingRequests",
  "reports",
  "chemistry",
] as const;
const detailOnly = [
  "filmStudyFile",
  "evidence",
  "report",
  "curve",
  "attachment",
  "original",
] as const;
const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const filtersByExperiment = new Set([
  "testingRequests",
  "experiments",
  "samples",
  "steps",
  "characterizations",
  "runs",
  "executions",
  "results",
  "scans",
  "comments",
  "attachments",
]);
const searchable = new Set([
  "filmStudies",
  "projects",
  "experiments",
  "materials",
  "recipes",
  "reports",
  "chemistry",
]);
const requestSchema = z
  .object({
    resource: z
      .enum(["catalog", ...resources, ...detailOnly])
      .default("catalog"),
    id: recordId.optional(),
    part: z.coerce.number().int().min(0).max(1023).optional(),
    after: recordId.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    experiment: recordId.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const single = detailOnly.some((item) => item === v.resource);
    if (
      (v.part !== undefined && v.resource !== "filmStudyFile") ||
      single !== Boolean(v.id) ||
      (v.q && !searchable.has(v.resource)) ||
      (single && (v.after || v.experiment)) ||
      (v.experiment && !filtersByExperiment.has(v.resource))
    )
      ctx.addIssue({ code: "custom", message: "Invalid selection" });
  });
export function parseReaderRequest(params: URLSearchParams) {
  if (new Set(params.keys()).size !== params.size) return null;
  const result = requestSchema.safeParse(Object.fromEntries(params));
  return result.success ? result.data : null;
}
type Input = z.infer<typeof requestSchema>;
const attachmentSelect = {
  id: true,
  fileName: true,
  mime: true,
  size: true,
  context: true,
  stepExecutionId: true,
  characterizationResultId: true,
  experimentId: true,
  commentId: true,
  equipmentId: true,
  labEnvironmentId: true,
  createdAt: true,
} as const;

function attachmentScope(
  exp: Prisma.ExperimentWhereInput,
  org: string,
  experimentOnly: boolean,
): Prisma.AttachmentWhereInput {
  return {
    feedbackId: null,
    OR: [
      { experiment: exp },
      { comment: { experiment: exp } },
      { stepExecution: { run: { experiment: exp } } },
      { characterizationResult: { characterization: { experiment: exp } } },
      ...(experimentOnly
        ? []
        : [
            { equipment: { organizationId: org } },
            { labEnvironment: { organizationId: org } },
          ]),
    ],
  };
}
// Original files can contain several scans. Include a file only if all linked
// experiments are in scope. Keep the instrument storage namespace exclusive.
function originalScope(reader: Reader): Prisma.InstrumentUploadWhereInput {
  const visible = experimentVisibilityScope(reader.actor);
  return {
    instrument: { organizationId: reader.actor.org },
    measurements: {
      every: {
        organizationId: reader.actor.org,
        OR: [{ experimentId: null }, { experiment: visible }],
      },
    },
  };
}
async function listRows(
  reader: Reader,
  input: Input,
): Promise<Array<{ id: string }>> {
  const { actor } = reader;
  const where = { organizationId: actor.org };
  const match = input.q
    ? { contains: input.q, mode: "insensitive" as const }
    : undefined;
  const exp = {
    ...experimentVisibilityScope(actor),
    ...(input.experiment ? { id: input.experiment } : {}),
  };
  const page = { orderBy: { id: "asc" as const }, take: input.limit + 1 };
  const keyset = input.after ? { id: { gt: input.after } } : {};
  const scanScope = {
    AND: [
      measurementVisibilityScope(actor),
      {
        OR: [
          { experiment: exp },
          ...(input.experiment ? [] : [{ experimentId: null }]),
        ],
      },
    ],
  };
  switch (input.resource) {
    case "filmStudies":
      return listPublishedStudies(
        actor.org,
        input.limit + 1,
        input.after,
        input.q,
      );
    case "experiments": {
      const rows = await db.experiment.findMany({
        ...page,
        where: {
          AND: [
            keyset,
            exp,
            ...(match
              ? [
                  {
                    OR: [
                      { code: match },
                      { shortCode: match },
                      { title: match },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: {
          id: true,
          code: true,
          shortCode: true,
          title: true,
          projectId: true,
          labels: { select: { label: { select: { id: true, name: true } } } },
          campaign: true,
          status: true,
          observation: true,
          problem: true,
          hypothesis: true,
          conclusion: true,
          metadata: true,
          submitNote: true,
          reviewNote: true,
          createdAt: true,
          updatedAt: true,
          approvedAt: true,
          submittedAt: true,
        },
      });
      return rows.map(({ metadata, ...row }) => {
        const m =
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? metadata
            : {};
        return {
          ...row,
          testPlan: m.testPlan ?? null,
          aiInterpretation: m.aiSummary ?? null,
        };
      });
    }
    case "projects":
      return db.project.findMany({
        ...page,
        where: { ...where, ...keyset, name: match },
        select: { id: true, name: true, active: true, createdAt: true },
      });
    case "samples":
      return db.sample.findMany({
        ...page,
        where: { ...keyset, experiment: exp },
        select: {
          id: true,
          experimentId: true,
          code: true,
          simCode: true,
          variationGroup: true,
          note: true,
          instrumentCodes: true,
        },
      });
    case "steps":
      return db.processStep.findMany({
        ...page,
        where: { ...keyset, experiment: exp },
        select: {
          id: true,
          experimentId: true,
          position: true,
          processId: true,
          name: true,
          layer: true,
          recipeId: true,
          environmentId: true,
          environmentConditions: true,
          equipmentId: true,
          notes: true,
          materials: {
            select: { materialId: true, amount: true, position: true },
          },
          parameters: {
            orderBy: { position: "asc" },
            select: {
              name: true,
              unit: true,
              value: true,
              source: true,
              variations: { select: { variationGroup: true, value: true } },
            },
          },
        },
      });
    case "characterizations":
      return db.characterization.findMany({
        ...page,
        where: { ...keyset, experiment: exp },
        select: {
          id: true,
          experimentId: true,
          position: true,
          name: true,
          sampleScope: true,
          settings: true,
          notes: true,
          processId: true,
          equipmentId: true,
          environmentId: true,
          environmentConditions: true,
        },
      });
    case "runs":
      return db.run.findMany({
        ...page,
        where: { ...keyset, experiment: exp },
        select: {
          id: true,
          experimentId: true,
          runNo: true,
          status: true,
          createdAt: true,
        },
      });
    case "executions":
      return db.stepExecution.findMany({
        ...page,
        where: {
          ...keyset,
          run: { experiment: exp },
          sample: { experiment: exp },
          step: { experiment: exp },
        },
        select: {
          id: true,
          runId: true,
          stepId: true,
          sampleId: true,
          actuals: true,
          environmentConditions: true,
          note: true,
          flagged: true,
          capturedAt: true,
          materialSelections: {
            select: { materialId: true, parameterName: true },
          },
        },
      });
    case "results":
      return db.characterizationResult.findMany({
        ...page,
        where: {
          ...keyset,
          characterization: { experiment: exp },
          AND: [
            { OR: [{ sampleId: null }, { sample: { experiment: exp } }] },
            { OR: [{ runId: null }, { run: { experiment: exp } }] },
          ],
        },
        select: {
          id: true,
          characterizationId: true,
          runId: true,
          sampleId: true,
          metrics: true,
          source: true,
          sourceMeasurementId: true,
          metricPolicy: true,
          capturedAt: true,
          note: true,
        },
      });
    case "scans":
      return db.jvMeasurement.findMany({
        ...page,
        where: { ...keyset, ...scanScope },
        select: {
          id: true,
          experimentId: true,
          sampleId: true,
          runId: true,
          serial: true,
          status: true,
          condition: true,
          direction: true,
          metrics: true,
          settings: true,
          measuredAt: true,
          createdAt: true,
          uploadId: true,
          instrumentId: true,
          material: true,
        },
      });
    case "comments":
      return db.experimentComment.findMany({
        ...page,
        where: { ...keyset, experiment: exp },
        select: { id: true, experimentId: true, body: true, createdAt: true },
      });
    case "attachments":
      return db.attachment.findMany({
        ...page,
        where: {
          ...keyset,
          ...attachmentScope(exp, actor.org, !!input.experiment),
        },
        select: attachmentSelect,
      });
    case "materials":
      return db.material.findMany({
        ...page,
        where: { ...where, ...keyset, name: match },
        select: publicMaterialSelect,
      });
    // The reader is issued exclusively by an active admin, who can read all recipe contents in this org.
    case "recipes":
      return db.recipe.findMany({
        ...page,
        where: { ...where, ...keyset, name: match },
        select: {
          id: true,
          name: true,
          summary: true,
          payload: true,
          archived: true,
          approvalStatus: true,
          updatedAt: true,
        },
      });
    case "processes":
      return db.process.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          name: true,
          kind: true,
          archived: true,
          defaultLayer: true,
          parameters: true,
        },
      });
    case "equipment":
      return db.equipment.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          name: true,
          nickname: true,
          processId: true,
          make: true,
          model: true,
          environmentId: true,
          parameters: true,
          workParameters: true,
          archived: true,
        },
      });
    case "environments":
      return db.labEnvironment.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          name: true,
          conditions: true,
          notes: true,
          archived: true,
        },
      });
    case "instruments":
      return db.instrument.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: { id: true, name: true, kind: true, active: true },
      });
    case "originals":
      return db.instrumentUpload.findMany({
        ...page,
        where: { ...keyset, ...originalScope(reader) },
        select: {
          id: true,
          instrumentId: true,
          fileName: true,
          sha256: true,
          size: true,
          mime: true,
          modifiedAt: true,
          status: true,
          receivedAt: true,
        },
      });
    case "testingRequests":
      return db.testingRequest.findMany({
        ...page,
        where: { ...keyset, ...where, experiment: exp },
        select: {
          id: true,
          experimentId: true,
          characterizationId: true,
          runId: true,
          sampleIds: true,
          note: true,
          createdAt: true,
        },
      });
    case "layers":
      return db.deviceLayer.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          code: true,
          name: true,
          nameZh: true,
          position: true,
        },
      });
    case "presets":
      return db.preset.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          name: true,
          kind: true,
          processId: true,
          payload: true,
          createdAt: true,
        },
      });
    case "categories":
      return db.materialCategoryDef.findMany({
        ...page,
        where: { ...where, ...keyset },
        select: {
          id: true,
          code: true,
          name: true,
          nameZh: true,
          layers: true,
        },
      });
    case "analyses":
      return db.analysisRun.findMany({
        ...page,
        where: { ...where, ...keyset, status: "DONE" },
        select: {
          id: true,
          question: true,
          lang: true,
          text: true,
          model: true,
          experimentCodes: true,
          experiments: true,
          samples: true,
          startedAt: true,
          finishedAt: true,
        },
      });
    case "reports":
      await requireReportAccess(actor);
      return db.labReport.findMany({
        ...page,
        where: {
          ...where,
          ...keyset,
          ...(match ? { OR: [{ titleEn: match }, { titleZh: match }] } : {}),
        },
        select: reportMetadataSelect,
      });
    case "chemistry": {
      await requireChemicalAccess(actor);
      const rows = await db.material.findMany({
        ...page,
        where: { ...where, ...keyset, archived: false, name: match },
        select: chemicalSelect,
      });
      return rows.map((row) => ({
        id: row.id,
        ...chemicalAnalysisDefinition(row),
      }));
    }
    default:
      throw new Error("Unsupported research collection");
  }
}
export async function readResearch(reader: Reader, input: Input) {
  const { resource, id } = input;
  if (
    ((resource === "reports" || resource === "report") && !reader.reports) ||
    (resource === "chemistry" && !reader.chemistry) ||
    (["filmStudies", "filmStudyFile"].includes(resource) && !reader.filmStudies)
  )
    throw new AuthorizationError();
  const { actor } = reader;
  const visible = experimentVisibilityScope(actor);
  const asOf = new Date().toISOString();
  if (resource === "catalog")
    return {
      schemaVersion: 1,
      asOf,
      collections: resources.filter(
        (r) =>
          (r !== "filmStudies" || reader.filmStudies) &&
          (r !== "reports" || reader.reports) &&
          (r !== "chemistry" || reader.chemistry),
      ),
      details: detailOnly.filter(
        (r) =>
          (r !== "report" || reader.reports) &&
          (r !== "filmStudyFile" || reader.filmStudies),
      ),
      maxPageSize: 100,
    };
  let data: unknown;
  let nextCursor: string | null = null;
  if (resource === "filmStudyFile") {
    const file = await findStudyFile(actor.org, id!);
    if (!file) return null;
    const number = input.part ?? 0;
    if (number >= partCount(file.size)) return null;
    const part = await readStudyPart(actor.org, file, number);
    data = {
      id: file.id,
      fileName: file.name,
      size: file.size,
      part: number,
      parts: partCount(file.size),
      sha256: part.sha256,
      encoding: "base64",
      body: Buffer.from(part.bytes).toString("base64"),
    };
  } else if (resource === "report") {
    const result = await readLabReportContent(actor, id);
    if (!result) return null;
    data = { id, html: Buffer.from(result.body).toString("utf8") };
  } else if (resource === "evidence") {
    if (
      !(await db.experiment.findFirst({
        where: { ...visible, id },
        select: { id: true },
      }))
    )
      return null;
    const exp = await getResultsExperiment(actor, id);
    if (!exp || exp.isTest) return null;
    data = redactSmilesJson(buildExperimentEvidence(exp));
  } else if (resource === "curve") {
    data = await db.jvMeasurement.findFirst({
      where: {
        id,
        AND: [
          measurementVisibilityScope(actor),
          { OR: [{ experimentId: null }, { experiment: visible }] },
        ],
      },
      select: {
        id: true,
        sampleId: true,
        experimentId: true,
        measuredAt: true,
        condition: true,
        direction: true,
        metrics: true,
        settings: true,
        curve: true,
      },
    });
    if (!data) return null;
  } else if (resource === "original") {
    const row = await db.instrumentUpload.findFirst({
      where: { id, ...originalScope(reader) },
      select: {
        fileName: true,
        mime: true,
        storedPath: true,
        instrumentId: true,
        sha256: true,
        size: true,
      },
    });
    if (
      !row ||
      !row.storedPath.startsWith(
        `organizations/${actor.org}/instruments/${row.instrumentId}/`,
      )
    )
      return null;
    const object = await readObject(actor, row.storedPath);
    if (!object) return null;
    if (
      object.body.byteLength !== row.size ||
      createHash("sha256").update(object.body).digest("hex") !== row.sha256
    )
      throw new Error("Instrument original integrity check failed");
    data = {
      id,
      fileName: row.fileName,
      mime: row.mime,
      sha256: row.sha256,
      encoding: "base64",
      body: Buffer.from(object.body).toString("base64"),
    };
  } else if (resource === "attachment") {
    const row = await db.attachment.findFirst({
      where: { id, ...attachmentScope(visible, actor.org, false) },
      select: { ...attachmentSelect, storedPath: true },
    });
    if (!row) return null;
    const object = await readObject(actor, row.storedPath);
    if (!object) return null;
    data = {
      id,
      fileName: row.fileName,
      mime: object.contentType,
      encoding: "base64",
      body: Buffer.from(object.body).toString("base64"),
    };
  } else {
    const page = await listRows(reader, input);
    const rows = page.slice(0, input.limit);
    nextCursor = page.length > input.limit ? rows[rows.length - 1].id : null;
    data = resource === "chemistry" ? rows : redactSmilesJson(rows);
  }
  await recordUserAudit(db, {
    actor,
    action: "research.reader.read",
    entityType: "ResearchReaderKey",
    entityId: reader.id,
    metadata: {
      collection: resource,
      rows: Array.isArray(data) ? data.length : 1,
    },
  });
  return { schemaVersion: 1, asOf, resource, nextCursor, data };
}
