"use client";
import { useState, useTransition } from "react";
import { issue, revoke } from "./actions";
type Props = {
  zh: boolean;
  settings: {
    reportAccess: boolean;
    chemicalAccess: boolean;
    keys: {
      id: string;
      label: string;
      expiresAt: Date;
      reports: boolean;
      chemistry: boolean;
    }[];
  };
};
export function ReaderKeys({ zh, settings }: Props) {
  const t = (en: string, cn: string) => (zh ? cn : en);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState(false);
  const [busy, start] = useTransition();
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <h1 className="text-lg font-bold">
        {t("Research agent access", "科研智能体访问")}
      </h1>
      <p>
        {t(
          "Give a trusted agent a read-only key for this organization’s experiments, measurements, files, materials and recipes. The agent can download this data. Choose a workspace approved for your lab’s research.",
          "为可信智能体创建只读密钥，可下载本组织的实验、测量、附件、材料和配方。请选择经批准可处理实验室研究数据的工作区。",
        )}
      </p>
      <a className="font-semibold underline" href="/pheno_lab.py" download>
        {t("Download the Python reader", "下载 Python 读取脚本")}
      </a>
      <form
        className="space-y-3 rounded border border-line bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget);
          setError(false);
          setSecret("");
          start(async () => {
            try {
              setSecret(
                await issue({
                  label: String(v.get("label")),
                  days: Number(v.get("days")),
                  reports: v.has("reports"),
                  chemistry: v.has("chemistry"),
                }),
              );
            } catch {
              setError(true);
            }
          });
        }}
      >
        <label className="block">
          {t("Agent name", "智能体名称")}
          <input
            name="label"
            required
            maxLength={80}
            className="block w-full rounded border border-line p-2"
          />
        </label>
        <label className="block">
          {t("Key lifetime", "有效期")}
          <select
            name="days"
            defaultValue="1"
            className="ml-2 rounded border border-line p-2"
          >
            {[1, 7, 30].map((d) => (
              <option key={d} value={d}>
                {d} {t(d === 1 ? "day" : "days", "天")}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <input
            disabled={!settings.reportAccess}
            name="reports"
            type="checkbox"
          />{" "}
          {t("Include published reports", "包含已发布的报告")}
        </label>
        <label className="block">
          <input
            disabled={!settings.chemicalAccess}
            name="chemistry"
            type="checkbox"
          />{" "}
          {t(
            "Include private molecular definitions (SMILES)",
            "包含受限分子结构数据（SMILES）",
          )}
        </label>
        <button
          disabled={busy}
          className="rounded bg-brand-deep px-3 py-2 text-white"
        >
          {t("Create read-only key", "创建只读密钥")}
        </button>
      </form>
      {secret && (
        <section className="space-y-2 rounded border border-line bg-white p-4">
          <label className="block">
            {t(
              "Copy this key now. Run python3 pheno_lab.py configure on the agent’s machine and paste it at the hidden prompt.",
              "请立即复制密钥。在智能体电脑上运行 python3 pheno_lab.py configure，并在隐藏输入提示下粘贴密钥。",
            )}
            <input
              aria-label="Research reader key"
              className="block w-full rounded border p-2 font-mono"
              readOnly
              value={secret}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button className="underline" onClick={() => setSecret("")}>
            {t("Hide key", "隐藏密钥")}
          </button>
        </section>
      )}
      {error && (
        <p role="alert">
          {t(
            "The request could not be completed. Refresh to check your access and active keys.",
            "请求未完成，请刷新页面查看权限和有效密钥。",
          )}
        </p>
      )}
      <section>
        <h2 className="font-bold">{t("Active keys", "有效密钥")}</h2>
        {settings.keys.length === 0 && (
          <p>{t("No active keys.", "暂无有效密钥。")}</p>
        )}
        {settings.keys.map((k) => (
          <div
            key={k.id}
            className="flex items-center justify-between gap-4 border-b border-line py-2"
          >
            <div className="min-w-0 break-words">
              <strong>{k.label}</strong>
              <p className="text-sm">
                {t("Expires", "到期")}{" "}
                {new Date(k.expiresAt)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 16)}{" "}
                UTC {k.reports ? t(" · Reports", " · 报告") : ""}
                {k.chemistry
                  ? t(" · Private chemistry", " · 私有化学数据")
                  : ""}
              </p>
            </div>
            <button
              disabled={busy}
              className="underline"
              onClick={() => {
                setError(false);
                start(async () => {
                  try {
                    await revoke(k.id);
                    setSecret("");
                  } catch {
                    setError(true);
                  }
                });
              }}
            >
              {t("Revoke", "撤销")}
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
