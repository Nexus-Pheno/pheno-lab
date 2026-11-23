"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useRef, useId } from "react";
import { useLang } from "@/lib/i18n/LanguageProvider";
import type { portalData } from "@/modules/film-studies/query";
import { methods, searchMethods } from "@/modules/film-studies/methods";
import { PART_BYTES, partCount } from "@/modules/film-studies/schema";
type Data = Awaited<ReturnType<typeof portalData>>;
type Draft = Data["drafts"][number];
const field =
  "block w-full rounded border border-line bg-white px-3 py-2 text-sm";
const button =
  "rounded border border-line bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50";
const nameOf = (code: string) => {
  const m = methods.find((x) => x.code === code);
  return m ? m.code + " · " + m.en + " / " + m.zh : code;
};
async function post(data: unknown) {
  const response = await fetch("/api/film-studies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.json();
}
function MethodPicker({
  value,
  onChange,
  zh,
  disabled,
}: {
  value: string;
  onChange: (s: string) => void;
  zh: boolean;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const items = searchMethods(query),
    id = useId();
  const choose = (code: string) => {
    onChange(code);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="relative">
      <label className="block font-semibold" htmlFor={id}>
        {zh ? "表征方法" : "Characterization method"}
      </label>
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={id + "-items"}
        aria-activedescendant={
          open && items[active] ? id + "-" + active : undefined
        }
        disabled={disabled}
        className={field}
        placeholder={
          zh
            ? "输入中文、英文或缩写，如开尔文、UPS"
            : "Search in English, Chinese or by abbreviation, e.g. UPS"
        }
        value={open ? query : value ? nameOf(value) : ""}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          onChange("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            return;
          }
          if (e.key === "Enter" && open) {
            e.preventDefault();
            if (items[active]) choose(items[active].code);
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            const next = Math.max(
              0,
              Math.min(
                items.length - 1,
                active + (e.key === "ArrowDown" ? 1 : -1),
              ),
            );
            setActive(next);
            document
              .getElementById(id + "-" + next)
              ?.scrollIntoView({ block: "nearest" });
          }
        }}
      />
      {open && (
        <div
          id={id + "-items"}
          role="listbox"
          className="absolute z-10 max-h-64 w-full overflow-y-auto rounded border border-line bg-white shadow"
        >
          {items.map((m, i) => (
            <div
              key={m.code}
              id={id + "-" + i}
              role="option"
              aria-selected={i === active}
              className={
                "cursor-pointer p-2 text-sm hover:bg-brand-soft " +
                (i === active ? "bg-subtle" : "")
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(m.code)}
            >
              {nameOf(m.code)}
            </div>
          ))}
          {!items.length && (
            <button
              type="button"
              className={button}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose("OTHER")}
            >
              {zh ? "使用其他方法" : "Use another method"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export function StudiesPortal({
  materials,
  records,
  drafts,
  total,
  page,
}: Data & { page: number }) {
  const zh = useLang() === "zh",
    t = (en: string, cn: string) => (zh ? cn : en);
  const router = useRouter();
  const [method, setMethod] = useState(""),
    [custom, setCustom] = useState(""),
    [notes, setNotes] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [term, setTerm] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState("");
  const [measuredOn, setMeasuredOn] = useState("");
  const requestId = useRef<string | null>(null),
    fileField = useRef<HTMLInputElement>(null);
  function reset() {
    setMeasuredOn("");
    setMethod("");
    setCustom("");
    setNotes("");
    setSelected([]);
    setTerm("");
    setFiles([]);
    setDraft(null);
    requestId.current = null;
    if (fileField.current) fileField.current.value = "";
  }
  function resume(row: Draft) {
    reset();
    setError("");
    setProgress("");
    setDraft(row);
    setMeasuredOn(
      row.measuredOn ? row.measuredOn.toISOString().slice(0, 10) : "",
    );
    setMethod(row.method);
    setCustom(row.customMethod);
    setNotes(row.notes);
    setSelected(row.materials.map((m) => m.id));
    requestId.current = row.id;
    window.scrollTo(0, 0);
    fileField.current?.focus();
  }
  const locked = busy || Boolean(draft);
  const submittedNotes = [term.trim(), notes.trim()].filter(Boolean).join("\n");
  async function upload() {
    setBusy(true);
    setError("");
    let committed = false;
    try {
      if (
        !method ||
        !files.length ||
        (!selected.length && !submittedNotes) ||
        (method === "OTHER" && !custom.trim())
      )
        throw Error("invalid");
      if (
        draft &&
        (draft.files.length !== files.length ||
          draft.files.some(
            (f, i) => f.name !== files[i].name || f.size !== files[i].size,
          ))
      )
        throw Error("manifest");
      const id = requestId.current ?? crypto.randomUUID();
      requestId.current = id;
      const saved = await post({
        action: "start",
        data: {
          id,
          method,
          measuredOn: measuredOn || undefined,
          customMethod: method === "OTHER" ? custom : "",
          notes: submittedNotes,
          materialIds: selected,
          files: files.map((f) => ({ name: f.name, size: f.size })),
        },
      });
      if (!saved.publishedAt) {
        for (const [i, file] of files.entries()) {
          const received = new Map<number, string>(
            saved.files[i].parts.map(
              (p: { number: number; sha256: string }) => [p.number, p.sha256],
            ),
          );
          for (let n = 0; n < partCount(file.size); n++) {
            setProgress(
              t("Uploading", "正在上传") +
                " " +
                file.name +
                " · " +
                (n + 1) +
                "/" +
                partCount(file.size),
            );
            const chunk = file.slice(n * PART_BYTES, (n + 1) * PART_BYTES);
            if (received.has(n)) {
              const digest = await crypto.subtle.digest(
                "SHA-256",
                await chunk.arrayBuffer(),
              );
              const hex = Array.from(new Uint8Array(digest), (v) =>
                v.toString(16).padStart(2, "0"),
              ).join("");
              if (hex !== received.get(n)) throw Error("conflict");
              continue;
            }
            const r = await fetch(
              "/api/film-studies/files/" + saved.files[i].id + "?part=" + n,
              {
                method: "PUT",
                body: chunk,
              },
            );
            if (!r.ok) throw Error((await r.json()).error);
          }
        }
      }
      setProgress(t("Saving and interpreting notes…", "正在保存并整理记录…"));
      const result = await post({ action: "finish", id });
      committed = true;
      setProgress(
        result.interpreted
          ? t("Characterization saved.", "表征记录已保存。")
          : t(
              "Saved. AI extraction is available to retry below.",
              "已保存。可在记录中重试 AI 整理。",
            ),
      );
      reset();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg === "manifest"
          ? t(
              "Select the original files in the order shown.",
              "请按显示顺序重新选择原始文件。",
            )
          : msg === "conflict"
            ? t(
                "The selected files or notes differ from this upload. Resume with the originals or start a new record.",
                "本次选择与原上传不一致。请选择原文件继续，或新建记录。",
              )
            : msg === "invalid"
              ? t(
                  "Choose a method, add materials or notes, and attach a nonempty file (under 2 GiB each).",
                  "请选择方法，填写材料或备注，并上传非空文件（每个小于 2 GiB）。",
                )
              : t(
                  "Upload interrupted. Retry with the same files to continue.",
                  "上传中断。请使用相同文件重试。",
                ),
      );
      setProgress("");
    } finally {
      setBusy(false);
      router.refresh();
      if (committed) requestId.current = null;
    }
  }
  async function retry(id: string) {
    setBusy(true);
    setError("");
    try {
      const r = await post({ action: "interpret", id });
      setProgress(
        r.interpreted
          ? t("Notes interpreted.", "备注已整理。")
          : t(
              "Notes are saved. AI is temporarily unavailable.",
              "备注已保存，AI 暂时无法整理。",
            ),
      );
    } catch {
      setError(
        t(
          "Could not interpret the notes. Please retry.",
          "暂时无法整理备注，请重试。",
        ),
      );
    } finally {
      setBusy(false);
      router.refresh();
    }
  }
  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-7">
        <header>
          <h1 className="text-2xl font-bold">
            {t("Characterizations", "独立表征")}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t(
              "Record a thin-film measurement with its materials, lab notes and original files.",
              "记录薄膜表征方法、所用材料和实验备注，并保存仪器原始文件。",
            )}
          </p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void upload();
          }}
          className="space-y-4 rounded border border-line bg-surface p-4 sm:p-5"
        >
          <MethodPicker
            value={method}
            onChange={setMethod}
            disabled={locked}
            zh={zh}
          />
          {method === "OTHER" && (
            <label className="block">
              {t("Method name", "方法名称")}
              <input
                className={field}
                required
                disabled={locked}
                maxLength={160}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>
          )}
          <div>
            <label className="font-semibold" htmlFor="study-material">
              {t("Library materials", "材料库材料")}
            </label>
            <input
              id="study-material"
              className={field}
              list="study-material-list"
              disabled={locked}
              value={term}
              placeholder={t(
                "Search for a material, or describe it in the notes",
                "搜索材料，也可直接在备注中描述",
              )}
              onChange={(e) => {
                const value = e.target.value,
                  m = materials.find((m) => m.name === value);
                if (m) {
                  setSelected((old) => [...new Set([...old, m.id])]);
                  setTerm("");
                } else setTerm(value);
              }}
            />
            <datalist id="study-material-list">
              {materials
                .filter((m) => !selected.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.name} />
                ))}
            </datalist>
            {selected.map((id) => (
              <button
                key={id}
                disabled={locked}
                type="button"
                className="mr-2 mt-2 rounded bg-brand-soft px-2 py-1 text-sm"
                onClick={() => setSelected((s) => s.filter((m) => m !== id))}
              >
                {materials.find((m) => m.id === id)?.name ??
                  draft?.materials.find((m) => m.id === id)?.name}{" "}
                ×
              </button>
            ))}
          </div>
          <label className="block font-semibold">
            {t("Materials and lab notes", "材料与实验备注")}
            <textarea
              rows={3}
              disabled={locked}
              maxLength={12000}
              className={field + " font-normal"}
              value={notes}
              placeholder={t(
                "Which film or sample did you test? Include any settings, observations and units.",
                "测试了哪种薄膜或样品？可填写测试条件、观察结果和单位。",
              )}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <label className="block">
            {t("Measurement date (optional)", "测试日期（选填）")}
            <input
              className={field}
              type="date"
              disabled={locked}
              value={measuredOn}
              onChange={(e) => setMeasuredOn(e.target.value)}
            />
          </label>
          <label className="block font-semibold">
            {t("Original files", "原始文件")}
            <input
              className={field}
              ref={fileField}
              type="file"
              multiple
              disabled={busy}
              onChange={(e) => {
                const added = Array.from(e.target.files ?? []);
                setFiles((previous) => [...previous, ...added]);
                e.target.value = "";
              }}
            />
          </label>
          <p className="text-sm text-muted">
            {t(
              "Add images, instrument files, spreadsheets or a ZIP of an instrument folder. Up to 100 files, each under 2 GiB.",
              "可添加图片、仪器文件、表格，或将仪器文件夹压缩为 ZIP。最多 100 个文件，每个小于 2 GiB。",
            )}
          </p>
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li
                  className="flex items-center justify-between gap-3 text-sm"
                  key={i}
                >
                  <span className="break-all">{f.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    className="underline"
                    aria-label={t("Remove ", "移除 ") + f.name}
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, j) => i !== j))
                    }
                  >
                    {t("Remove", "移除")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draft && (
            <p className="text-sm">
              {t(
                "Resume with these files, in order",
                "继续上传时请按顺序选择这些文件",
              )}{" "}
              · {draft.files.map((f) => f.name).join(" · ")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              disabled={
                busy ||
                !method ||
                !files.length ||
                (!selected.length && !submittedNotes)
              }
              className="rounded bg-brand-deep px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {t("Save characterization", "保存表征记录")}
            </button>
            {(draft || error) && (
              <button
                className={button}
                type="button"
                disabled={busy}
                onClick={() => {
                  reset();
                  setError("");
                  setProgress("");
                }}
              >
                {t("Start another record", "新建其他记录")}
              </button>
            )}
          </div>
        </form>
        <p role="status" className="text-sm">
          {progress}
        </p>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        {drafts.length > 0 && (
          <details className="rounded border border-line bg-surface p-3">
            <summary>
              {t("Your unfinished uploads", "我的未完成上传")} ({drafts.length})
            </summary>
            {drafts.map((d) => (
              <button
                key={d.id}
                className="block py-2 text-left underline"
                type="button"
                disabled={busy}
                onClick={() => resume(d)}
              >
                {t("Resume", "继续上传")} · {d.customMethod || d.method} ·{" "}
                {d.files[0]?.name}
              </button>
            ))}
          </details>
        )}
        <section className="space-y-2">
          <h2 className="font-bold">
            {t("Saved characterizations", "已保存的表征")} ({total})
          </h2>
          {!records.length && (
            <p className="text-sm text-muted">
              {t(
                "Saved measurements will appear here.",
                "保存的表征记录将显示在这里。",
              )}
            </p>
          )}
          {records.map((row) => {
            const fields = row.interpretation as Record<string, unknown> | null;
            return (
              <details
                key={row.id}
                className="rounded border border-line bg-surface p-4"
              >
                <summary className="cursor-pointer font-semibold">
                  {row.customMethod || row.method} ·{" "}
                  {row.materials.map((m) => m.name).join(", ") ||
                    row.notes.slice(0, 65)}{" "}
                  <span className="text-xs font-normal text-muted">
                    {row.author.name} ·{" "}
                    {new Intl.DateTimeFormat(zh ? "zh-CN" : "en-GB", {
                      timeZone: "Asia/Shanghai",
                    }).format(row.publishedAt!)}
                  </span>
                </summary>
                <p className="my-2 text-sm">
                  {row.customMethod || nameOf(row.method)}
                  {row.measuredOn &&
                    " · " +
                      t("Measured", "测试日期") +
                      " " +
                      row.measuredOn.toISOString().slice(0, 10)}
                </p>
                <p className="whitespace-pre-wrap break-words">{row.notes}</p>
                {fields ? (
                  <div className="my-3 border-l-2 border-brand pl-3 text-sm">
                    <strong>
                      {t("AI extraction from notes", "AI 从备注中提取")}
                    </strong>
                    {(
                      [
                        "materials",
                        "samples",
                        "conditions",
                        "observations",
                      ] as const
                    ).map((k, i) =>
                      Array.isArray(fields[k]) && fields[k].length > 0 ? (
                        <p key={k}>
                          {
                            (zh
                              ? ["材料", "样品", "条件", "观察"]
                              : [
                                  "Materials",
                                  "Samples",
                                  "Conditions",
                                  "Observations",
                                ])[i]
                          }{" "}
                          · {fields[k].join(" · ")}
                        </p>
                      ) : null,
                    )}
                  </div>
                ) : (
                  row.notes && (
                    <button
                      disabled={busy}
                      className={button}
                      onClick={() => void retry(row.id)}
                    >
                      {t("Interpret notes with AI", "用 AI 整理备注")}
                    </button>
                  )
                )}
                <ul className="mt-2 space-y-1">
                  {row.files.map((f) => (
                    <li key={f.id}>
                      <a
                        className="break-all text-brand-deep underline"
                        href={"/api/film-studies/files/" + f.id}
                        download
                      >
                        {f.name}
                      </a>{" "}
                      <small>{(f.size / 1048576).toFixed(2)} MB</small>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
          <nav className="flex gap-4">
            {page > 1 && (
              <Link href={"?page=" + (page - 1)}>
                {t("Previous", "上一页")}
              </Link>
            )}
            {20 * page < total && (
              <Link href={"?page=" + (page + 1)}>{t("Next", "下一页")}</Link>
            )}
          </nav>
        </section>
      </div>
    </main>
  );
}
