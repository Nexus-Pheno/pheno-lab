"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  getDatabaseSummary as getDatabaseSummaryQuery,
  searchExperiments as searchExperimentsQuery,
  type DatabaseSummary,
  type SearchHit,
  type SearchResponse,
} from "@/modules/insights/query";
import {
  getActivityFeed as getActivityFeedQuery,
  type ActivityFeed,
} from "@/modules/audit/query";
import {
  analyzeHistory as analyzeHistoryService,
  type HistoryAnalysis,
} from "@/modules/insights/analysis-service";

export type { DatabaseSummary, SearchHit, SearchResponse, ActivityFeed };
export type { HistoryAnalysis };

export async function analyzeHistory(
  question: string,
  lang: "en" | "zh",
): Promise<HistoryAnalysis | null> {
  return analyzeHistoryService(
    await requireSession(),
    z.string().trim().min(1).max(1000).parse(question),
    z.enum(["en", "zh"]).parse(lang),
  );
}

export async function getActivityFeed(): Promise<ActivityFeed> {
  return getActivityFeedQuery(await requireSession());
}

export async function getDatabaseSummary(
  includeTest = false,
): Promise<DatabaseSummary> {
  return getDatabaseSummaryQuery(
    await requireSession(),
    z.boolean().parse(includeTest),
  );
}

export async function searchExperiments(
  query: string,
  includeTest = false,
): Promise<SearchResponse> {
  return searchExperimentsQuery(
    await requireSession(),
    z.string().trim().max(1000).parse(query),
    z.boolean().parse(includeTest),
  );
}
