#!/usr/bin/env python3
"""Turn one operator's folder into IngestItems for the quality gate.

    python3 scripts/parse-operator.py <operator> [--out FILE]
    node scripts/stage-ingest.js --file FILE

What it handles, learned from surveying all sixteen folders:

  * template boilerplate — every master file ships with worked example rows
    (identical across operators); they are dropped, not imported
  * versioned copies — only the richest master file per operator is used
  * merged cells — a batch's metadata is merged down over its sample rows
  * Excel date damage — a sample called "1-6" is stored as the serial 46028
  * sub-cell suffixes — the sheet says "2018", the JV export "2018-8-Rev"
  * characterisation-only sheets (其他实验, and zoey's CV / 接触角 tabs), which
    are real experiments with no device and no J-V data

Nothing is written to the database here; the output is reviewed at /ingest.
"""
import argparse, csv, datetime, io, json, os, re, sys, zipfile
from collections import defaultdict
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from importlib.machinery import SourceFileLoader
sv = SourceFileLoader("sv", os.path.join(HERE, "survey-historical.py")).load_module()

ROOT = sv.ROOT
DEVICE = {"大面积": "LARGE", "小面积": "SMALL"}

# Row counts of the shipped template examples, verified byte-identical across
# operators. Rows are additionally content-checked before being dropped.
TEMPLATE_FIRST_IDS = {
    "大面积": {"06-8-rev", "09-8-rev", "15-8-rev"},
    "小面积": {"control1-1", "control1-2", "one1-1"},
    "其他实验": {"573_4", "573_5", "573_6"},
}

# Master-sheet column → the process that produced it, plus the parameter
# columns that describe that step. Mirrors the lab's actual process library.
STEP_MAP = [
    ("基底清洗工艺", "Cleaning / washing", "Substrate cleaning", []),
    ("NiOx层", "Sputter PVD", "NiOx layer", []),
    ("SAM材料", "Blade coating", "SAM deposition",
     ["SAM溶剂", "SAM工艺 溶剂", "SAM工艺", "SAM层退火温度", "SAM退火时间", "SAM层退火时间"]),
    ("钙钛矿层工艺", "Blade coating", "Perovskite layer",
     ["钙钛矿配方", "钙钛矿体相钝化剂", "钙钛矿体相添加剂"]),
    ("钙钛矿VCD+退火", "VCD", "VCD + anneal", []),
    ("钙钛矿上表面钝化层", "Surface treatment", "Top passivation", []),
    ("ETL层", "Thermal evaporation", "ETL", []),
    ("电极", "Thermal evaporation", "Electrode", []),
]

# JV metric columns → the metric keys stored on a characterisation result.
METRICS = {
    "Jsc (mA/cm^2)": "jsc", "Isc (mA)": "isc", "Voc (V)": "voc", "Eff (%）": "pce",
    "Pmax (mW)": "pmax", "FF (%)": "ff", "Vmax(V)": "vmax", "Imax(mA)": "imax",
    "Rs (ohm）": "rs", "Rsh （ohm）": "rsh", "Area （cm^2)": "area",
    "Voc/V": "voc", "Isc/mA": "isc", "Pmax/mW": "pmax", "Vpmax/V": "vmax",
    "Ipmax/mA": "imax", "Rs/ohm": "rs", "Rsh/ohm": "rsh", "Jsc/mA.cm-2": "jsc",
    "FF": "ff", "η/%": "pce", "Avg.CA °": "contactAngle", "L.CA °": "contactAngleL",
    "R.CA °": "contactAngleR", "ip(10^-6)": "ip",
}

# Characterisation type (其他实验 实验类型) → process in the library.
CHAR_PROCESS = {
    "sem": "SEM", "uv-vis": "Ellipsometry", "uv": "Ellipsometry", "xrd": "XRD",
    "pl": "Photoluminescence", "cv": "Ellipsometry", "接触角": "Ellipsometry",
    "eqe": "EQE", "afm": "Profilometry",
}


def pick_master(base):
    """The richest master file — versioned copies are supersets of each other."""
    best, best_rows = None, -1
    for dp, _, fs in os.walk(base):
        for f in fs:
            if not f.lower().endswith(".xlsx") or f.startswith("~$"):
                continue
            p = os.path.join(dp, f)
            try:
                z, shared, sheets = sv.sheets_of(p)
            except Exception:
                continue
            names = [s[0] for s in sheets]
            if not ({"大面积", "小面积"} & set(names)):
                continue
            total = 0
            for _, tgt in sheets:
                try:
                    total += len(sv.grid_of(z, shared, tgt))
                except Exception:
                    pass
            if total > best_rows:
                best, best_rows = p, total
    return best


# How many worked example rows the shipped template carries per sheet.
TEMPLATE_ROWS = {"大面积": 18, "小面积": 14, "其他实验": 8}


def drop_template_block(sheet, rows, col):
    """Remove the template's worked examples from the top of a sheet.

    The examples are identical in every operator's file, so importing them
    would create the same fake experiments sixteen times over. They are only
    dropped when the sheet actually starts with them — an operator who deleted
    them keeps all their rows.
    """
    ci = col.get("原始数据编号")
    n = TEMPLATE_ROWS.get(sheet, 0)
    if ci is None or not rows or n == 0:
        return rows
    head = {(r.get(ci) or "").strip().lower() for r in rows[:3]}
    if not (head & TEMPLATE_FIRST_IDS.get(sheet, set())):
        return rows
    return rows[n:]


def clean(v):
    v = (v or "").strip()
    return "" if v in {"无", "/", "-", "#REF!", "nan"} else v


def num(v):
    """A metric, or None. Non-finite values are dropped rather than recorded.

    Sheets contain the odd NaN from a broken formula; json.dump would emit a
    bare NaN, which is not valid JSON and rejects the whole operator's batch.
    """
    try:
        f = float(str(v).strip())
    except Exception:
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, 6)


def index_jv_files(base):
    """sample-key → [file paths], from both file names and file contents."""
    idx = defaultdict(list)
    for dp, _, fs in os.walk(base):
        for f in fs:
            if not f.lower().endswith(".csv"):
                continue
            p = os.path.join(dp, f)
            if not sv.is_jv_csv(p):
                continue
            keys = set()
            m = re.match(r"(.+?)_[A-Za-z]+_(Table|Data)_\d+", f)
            if m:
                keys |= sv.aliases(m.group(1))
            try:
                _, names = sv.classify(p)
            except Exception:
                names = []
            for n in names:
                keys |= sv.aliases(n)
            for k in keys:
                if k and p not in idx[k]:
                    idx[k].append(p)
    return idx


def parse(operator, out_path):
    base = os.path.join(ROOT, operator)
    master = pick_master(base)
    if not master:
        print(f"no master sheet found for {operator}", file=sys.stderr)
        return []
    z, shared, sheets = sv.sheets_of(master)
    jv = index_jv_files(base)
    owner = operator.strip()
    # Folder names carry noise ("AI数据统计-Wanda", "Ryan-实验数据及AI数据收集表").
    m = re.search(r"[A-Za-z]{2,}", owner)
    owner = (m.group(0) if m else owner).capitalize()

    items = []
    for sheet, tgt in sheets:
        is_device = sheet in DEVICE
        # zoey's CV / 接触角 tabs reuse the 其他实验 schema — treat any sheet with
        # 实验类型 as characterisation, whatever it is called.
        g = sv.grid_of(z, shared, tgt)
        if len(g) < 2:
            continue
        hdr = g[min(g)]
        col = {v: k for k, v in hdr.items()}
        if not is_device and "实验类型" not in col:
            continue
        rows = [g[r] for r in sorted(g)[1:]]
        # drop empty rows and the shipped examples
        rows = [r for r in rows if any(clean(v) for v in r.values())]
        rows = drop_template_block(sheet if is_device else "其他实验", rows, col)
        if not rows:
            continue

        batches = defaultdict(list)
        for r in rows:
            b = clean(r.get(col.get("实验批次编号"), "")) or "1"
            d = re.sub(r"[^0-9]", "", clean(r.get(col.get("数据日期"), "")))[:8]
            batches[(b, d)].append(r)

        for (batch, date), brows in batches.items():
            first = brows[0]
            get = lambda k: clean(first.get(col.get(k), "")) if col.get(k) is not None else ""
            purpose = get("实验目的") or get("实验设计DOE")
            title = (purpose or get("实验类型") or f"{sheet} batch {batch}")[:120]

            steps, chars = [], []
            if is_device:
                for src, proc, label, param_cols in STEP_MAP:
                    val = get(src)
                    if not val:
                        continue
                    params = []
                    for pc in param_cols:
                        pv = get(pc)
                        if pv:
                            params.append({"name": pc, "unit": "", "value": pv})
                    mats = [val] if src in ("SAM材料",) else []
                    recipe = get("钙钛矿配方") if src == "钙钛矿层工艺" else ""
                    steps.append({
                        "processName": proc,
                        "name": f"{label} — {val}"[:120],
                        "parameters": params,
                        "materialNames": mats,
                        "recipeName": recipe,
                    })
                chars.append({"processName": "J-V — solar simulation", "name": "J-V"})
            else:
                ctype = get("实验类型")
                proc = CHAR_PROCESS.get(ctype.strip().lower(), "SEM")
                mat = get("实验材料")
                if mat:
                    steps.append({
                        "processName": "Surface treatment",
                        "name": f"Sample preparation — {mat}"[:120],
                        "parameters": [], "materialNames": [mat], "recipeName": "",
                    })
                chars.append({"processName": proc, "name": ctype or "Characterisation"})

            samples = []
            for r in brows:
                code = clean(r.get(col.get("原始数据编号"), "")) or clean(r.get(col.get("Name"), ""))
                code = code or clean(r.get(col.get("Serial NO."), ""))
                if not code:
                    continue
                # Excel turned names like "1-6" into the serial 46028. Publish
                # the repaired name — matching already used it, and a sample
                # displayed as "46023" is unreadable to the people who ran it.
                repaired = sv.undate(code)
                if repaired:
                    code = repaired
                metrics = {}
                for label, key in METRICS.items():
                    ci = col.get(label)
                    if ci is None:
                        continue
                    n = num(r.get(ci))
                    if n is not None:
                        metrics[key] = n
                files = []
                for k in sv.aliases(code):
                    for f in jv.get(k, []):
                        if f not in files:
                            files.append(f)
                samples.append({"code": code[:100], "metrics": metrics,
                                "files": files[:8], "note": ""})

            if not samples:
                continue
            linked = sum(1 for s in samples if s["files"])
            items.append({
                "kind": "EXPERIMENT",
                "title": f"{owner} · {sheet} · batch {batch}{' · ' + date if date else ''}",
                "sourceFile": os.path.relpath(master, ROOT),
                "confidence": (
                    f"Parsed from {os.path.basename(master)} sheet 「{sheet}」 batch {batch}. "
                    f"{len(samples)} sample(s), {linked} linked to raw JV file(s). "
                    "Template example rows and empty rows were excluded; merged batch "
                    "metadata was expanded across its sample rows."
                ),
                "payload": {
                    "title": title,
                    "operator": owner,
                    "scale": DEVICE.get(sheet, "OTHER"),
                    "batchLabel": f"{sheet}-{batch}",
                    "date": date,
                    "campaign": get("实验设计DOE")[:80],
                    "hypothesis": purpose,
                    "problem": get("实验设计DOE"),
                    "conclusion": get("实验结论"),
                    "observation": get("失效分析"),
                    "steps": steps,
                    "characterizations": chars,
                    "samples": samples,
                    "sourceFiles": [os.path.relpath(master, ROOT)],
                },
            })

    with open(out_path, "w") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    tot_s = sum(len(i["payload"]["samples"]) for i in items)
    tot_f = sum(len(s["files"]) for i in items for s in i["payload"]["samples"])
    print(f"{operator}: {len(items)} experiment(s), {tot_s} sample(s), {tot_f} file link(s) -> {out_path}")
    return items


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("operator")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    parse(a.operator, a.out or f"/tmp/ingest-{a.operator}.json")
