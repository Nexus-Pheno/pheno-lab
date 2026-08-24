// Vendor presets. Kept out of the "use server" action file, which may only
// export async functions — a const there breaks the build.
//
// These `models` lists are only a STARTING POINT for the dropdown. Model names
// change constantly (this list already went stale once: DeepSeek moved to v4
// while the app still offered "deepseek-chat"). The form's "Load models"
// button asks the provider's own /models endpoint, which is the only list that
// is ever authoritative. Treat what follows as a hint, not a source of truth.

export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** Docs page, so an admin can check what is current. */
  docs: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    // Verified against DeepSeek's pricing docs, 2026-08-21.
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    docs: "https://api-docs.deepseek.com/quick_start/pricing",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    docs: "https://platform.openai.com/docs/models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    docs: "https://docs.anthropic.com/en/docs/about-claude/models",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    models: [],
    docs: "",
  },
];
