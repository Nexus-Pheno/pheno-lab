import { cookies } from "next/headers";
import { translate, type Lang, type TKey } from "./dict";
import { localizeTerm } from "./terms";

export async function getLang(): Promise<Lang> {
  const c = (await cookies()).get("pheno_lang")?.value;
  return c === "zh" ? "zh" : "en";
}

export async function getT() {
  const lang = await getLang();
  return (key: TKey, vars?: Record<string, string>) => translate(lang, key, vars);
}

/** Server-side lab-vocabulary localization (read-only displays). */
export async function getTerm() {
  const lang = await getLang();
  return (s: string | null | undefined) => localizeTerm(lang, s);
}
