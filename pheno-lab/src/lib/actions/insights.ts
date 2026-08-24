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

export type { DatabaseSummary, SearchHit, SearchResponse };

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
