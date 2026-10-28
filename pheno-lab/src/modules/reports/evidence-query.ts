import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import { AuthorizationError } from "@/modules/authorization/policy";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { getResultsExperiment } from "@/modules/experiments/query";
import { buildExperimentEvidence } from "@/modules/experiments/result-evidence";
import {
  AI_SUMMARY_PROMPT_VERSION,
  AI_SUMMARY_RULE_VERSION,
} from "@/modules/experiments/summary-types";

export const REPORT_EVIDENCE_METHOD = "pheno-device-evidence-2026-10-28";
export const REPORT_EVIDENCE_SCOPE =
  "EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT";

const inputSchema = z.object({
  organizationSlug: z.string().trim().min(1).max(100),
  readerEmail: z.email().max(254),
  experimentCodes: z
    .array(z.string().trim().min(1).max(100))
    .max(250)
    .refine((values) => new Set(values).size === values.length),
  sourceSnapshotAt: z.iso.datetime({ offset: true }),
  reportWindowEnd: z.iso.datetime({ offset: true }),
});

/**
 * Existing operator shell only: no HTTP endpoint, write, provider call or grant.
 * This is private workflow evidence, not a recipient-facing chemistry export.
 */
export async function exportReportEvidence(raw: unknown) {
  const input = inputSchema.parse(raw);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
      const clock = await tx.$queryRaw<{ at: Date }[]>`
        SELECT transaction_timestamp() AS at
      `;
      const asOf = clock[0].at;
      if (
        new Date(input.reportWindowEnd) > new Date(input.sourceSnapshotAt) ||
        new Date(input.sourceSnapshotAt) > asOf
      ) {
        throw new Error("Evidence dates are not ordered.");
      }
      const reader = await tx.user.findFirst({
        where: {
          email: input.readerEmail,
          organization: { slug: input.organizationSlug, status: "ACTIVE" },
          role: { in: ["ADMIN", "MANAGER"] },
          active: true,
          pendingApproval: false,
          testingOnly: false,
          mustChangePassword: false,
          reportAccess: true,
        },
        select: { id: true, organizationId: true, role: true },
      });
      if (!reader) throw new AuthorizationError();
      const actor = {
        uid: reader.id,
        org: reader.organizationId,
        role: reader.role,
        testingOnly: false,
        mustChangePassword: false,
      };
      const where = {
        AND: [
          { code: { in: input.experimentCodes }, isTest: false },
          experimentVisibilityScope(actor, true),
        ],
      };
      const experiments = await tx.experiment.findMany({
        where,
        select: { id: true, code: true },
        orderBy: { code: "asc" },
        take: 251,
      });
      if (experiments.length !== input.experimentCodes.length) {
        throw new AuthorizationError("Requested evidence is unavailable.");
      }
      const ids = experiments.map((row) => row.id);
      const experimentFilter = { experimentId: { in: ids } };
      const [samples, results, scans, executions] = await Promise.all([
        tx.sample.count({ where: experimentFilter }),
        tx.characterizationResult.count({
          where: { characterization: experimentFilter },
        }),
        tx.jvMeasurement.count({ where: experimentFilter }),
        tx.stepExecution.count({ where: { step: experimentFilter } }),
      ]);
      if (
        samples > 20_000 ||
        results > 50_000 ||
        scans > 50_000 ||
        executions > 100_000
      ) {
        throw new Error("Report evidence read bound exceeded.");
      }
      const rows = [];
      for (const row of experiments) {
        const experiment = await getResultsExperiment(actor, row.id, tx);
        if (!experiment) throw new AuthorizationError();
        const evidence = buildExperimentEvidence(experiment);
        const metadata = experiment.metadata as {
          aiSummary?: {
            sourceHash?: string;
            policyVersion?: string;
            ruleVersion?: string;
            promptVersion?: string;
            reviewState?: string;
            referenceGroup?: string;
            characterizationId?: string;
          };
        } | null;
        const summary = metadata?.aiSummary;
        const interpretationEvidence = summary
          ? buildExperimentEvidence(experiment, {
              referenceGroup: summary.referenceGroup,
              characterizationId: summary.characterizationId,
            })
          : null;
        rows.push({
          experimentCode: row.code,
          evidence,
          aiInterpretation: {
            available: Boolean(summary),
            sourceHashMatches:
              Boolean(summary?.sourceHash) &&
              summary?.sourceHash === interpretationEvidence?.sourceHash,
            selectionMatchesPrimaryEvidence:
              summary?.sourceHash === evidence.sourceHash,
            versionCurrent:
              Boolean(summary) &&
              summary?.policyVersion === evidence.policyVersion &&
              summary?.ruleVersion === AI_SUMMARY_RULE_VERSION &&
              summary?.promptVersion === AI_SUMMARY_PROMPT_VERSION,
            expectedVersions: {
              policyVersion: evidence.policyVersion,
              ruleVersion: AI_SUMMARY_RULE_VERSION,
              promptVersion: AI_SUMMARY_PROMPT_VERSION,
            },
            currentInterpretationSourceHash:
              interpretationEvidence?.sourceHash ?? null,
            reviewState: summary?.reviewState ?? "draft",
            // Keep the interpretation private until its current source binding,
            // scientific content and publication projection are reviewed.
            summary: summary ?? null,
          },
        });
      }
      return {
        schemaVersion: 1,
        readOnly: true,
        classification: "PRIVATE_SHARED_APP_EVIDENCE_NOT_REPORT_HTML",
        methodVersion: REPORT_EVIDENCE_METHOD,
        selectionScope: REPORT_EVIDENCE_SCOPE,
        sourceSnapshotAt: input.sourceSnapshotAt,
        reportWindowEnd: input.reportWindowEnd,
        asOf: asOf.toISOString(),
        bounds: {
          experiments: rows.length,
          samples,
          results,
          scans,
          executions,
        },
        experiments: rows,
        limitations: [
          "Current accepted device results are cumulative at asOf, not a seven-day fabrication population.",
          "A matching AI source hash does not establish researcher review, experimental execution or mechanism.",
          "Private free-text conditions require a reviewed allowlist projection before shared publication.",
        ],
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 120_000,
    },
  );
}
