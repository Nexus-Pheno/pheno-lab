export const AI_SUMMARY_RULE_VERSION = "purpose-screening-0.5pp-v2";
export const AI_SUMMARY_PROMPT_VERSION = "concise-bilingual-results-v5";
/** Serializable AI interpretation state; safe to import from client components. */
export type AnalysisText = { en: string; zh: string };
export type AiResultInterpretation = {
  purpose: AnalysisText;
  objectiveAttainment: AnalysisText;
  groups: {
    group: string;
    judgment: AnalysisText;
    mainIssue: AnalysisText;
    mechanisms: AnalysisText[];
    nextTest: AnalysisText;
    expectedOutcome: AnalysisText;
    decision: AnalysisText;
  }[];
};
export type AiSummary = {
  text: string;
  lang: "en" | "zh";
  model: string;
  generatedAt: string;
  sourceHash?: string;
  policyVersion?: string;
  ruleVersion?: string;
  promptVersion?: string;
  interim?: boolean;
  referenceGroup?: string;
  characterizationId?: string;
  reviewState?: "draft" | "reviewed";
  reviewedAt?: string;
  reviewedBy?: string;
  analysis?: AiResultInterpretation;
};
export type AiSummaryOptions = {
  referenceGroup?: string;
  characterizationId?: string;
};
export type AiSummaryRun = {
  state: "running" | "done" | "failed" | "queued" | "stale";
  startedAt: string;
  lang: "en" | "zh";
  runId?: string;
  sourceHash?: string;
  referenceGroup?: string;
  characterizationId?: string;
};
export type AiSummaryState = {
  run: AiSummaryRun | null;
  summary: AiSummary | null;
  isStale: boolean;
  hasResults: boolean;
  evidenceHash: string;
  referenceGroup: string | null;
};
