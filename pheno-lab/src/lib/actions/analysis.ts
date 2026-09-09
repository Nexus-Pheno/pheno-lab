"use server";

import { requireSession } from "@/lib/auth";
import { readAnalysis } from "@/modules/analysis/ai-service";
import { buildTidyCsv } from "@/modules/analysis/export-service";

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
