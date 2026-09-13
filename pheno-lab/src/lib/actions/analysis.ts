"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireSession } from "@/lib/auth";
import { readAnalysis } from "@/modules/analysis/ai-service";
import { buildTidyCsv } from "@/modules/analysis/export-service";
import {
  getAnalysisRun,
  listAnalysisRuns,
  startAnalysisRun,
} from "@/modules/analysis/ask-service";

export async function analyseScope(
  question: string,
  scope: Record<string, string | undefined>,
  lang: "en" | "zh",
) {
  return readAnalysis(await requireSession(), { question, scope, lang });
}

export async function exportTidyCsv(scope: Record<string, string | undefined>) {
  return buildTidyCsv(await requireSession(), scope);
}

export async function askAnalysis(question: string, lang: "en" | "zh") {
  const run = await startAnalysisRun(await requireSession(), {
    question,
    lang,
  });
  revalidatePath("/analysis");
  return run;
}

export async function pollAnalysis(id: string) {
  return getAnalysisRun(
    await requireSession(),
    z.string().min(1).max(128).parse(id),
  );
}

export async function recentAnalyses() {
  return listAnalysisRuns(await requireSession());
}
