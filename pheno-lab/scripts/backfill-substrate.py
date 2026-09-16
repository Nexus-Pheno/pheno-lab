#!/usr/bin/env python3
"""Recover the substrate columns the 2026-08 import dropped.

    python3 scripts/backfill-substrate.py --out FILE
    node node_modules/tsx/dist/cli.mjs scripts/backfill-substrate.ts FILE [--apply]

The master sheets carry three batch-level columns that STEP_MAP in
parse-operator.py never read: 模组尺寸 (large-area sheets), 模组结构 / 器件结构,
and 基底. Technicians asked for the size back (实验系统反馈 2026-09-16 §三),
and all three are exactly the recipe conditions cross-experiment analysis
keys on. This script re-reads every master sheet with the importer's own
batch grouping and emits one record per batch, keyed the way the published
experiment's metadata is keyed (sourceFile, batchLabel, sourceDate). Nothing
is written here.
"""
import argparse, json, os, re, sys
from collections import defaultdict
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sv = SourceFileLoader("sv", os.path.join(HERE, "survey-historical.py")).load_module()
po = SourceFileLoader("po", os.path.join(HERE, "parse-operator.py")).load_module()

SIZE_RE = re.compile(r"(?<![\d.])(\d{2,3})(?![\d.])")


def normalized_size(raw: str) -> str:
    """"南玻50 ITO (1.1mm)" -> "50 mm", "100*100 mm" -> "100 mm", else ""."""
    for m in SIZE_RE.finditer(raw):
        n = int(m.group(1))
        if 20 <= n <= 400:
            return f"{n} mm"
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    records = []
    for operator in sorted(os.listdir(po.ROOT)):
        base = os.path.join(po.ROOT, operator)
        if not os.path.isdir(base):
            continue
        master = po.pick_master(base)
        if not master:
            continue
        z, shared, sheets = sv.sheets_of(master)
        for sheet, tgt in sheets:
            if sheet not in po.DEVICE:
                continue
            g = sv.grid_of(z, shared, tgt)
            if len(g) < 2:
                continue
            hdr = g[min(g)]
            col = {str(v).strip(): k for k, v in hdr.items()}
            rows = [g[r] for r in sorted(g)[1:]]
            rows = [r for r in rows if any(po.clean(v) for v in r.values())]
            rows = po.drop_template_block(sheet, rows, col)
            batches = defaultdict(list)
            for r in rows:
                b = po.clean(r.get(col.get("实验批次编号"), "")) or "1"
                d = re.sub(r"[^0-9]", "", po.clean(r.get(col.get("数据日期"), "")))[:8]
                batches[(b, d)].append(r)
            for (batch, date), brows in batches.items():
                first = brows[0]
                get = lambda k: po.clean(first.get(col.get(k), "")) if col.get(k) is not None else ""
                size_raw = get("模组尺寸")
                structure = get("模组结构") or get("器件结构")
                substrate = get("基底")
                extra = get("补充材料")
                fields = {}
                if size_raw:
                    fields["模组尺寸"] = size_raw
                    norm = normalized_size(size_raw)
                    if norm:
                        fields["基底尺寸"] = norm
                if structure:
                    fields["器件结构"] = structure
                if substrate:
                    fields["基底"] = substrate
                if extra and extra not in ("无", "/", "-"):
                    fields["补充材料"] = extra
                if not fields:
                    continue
                records.append({
                    "sourceFile": os.path.relpath(master, po.ROOT),
                    "batchLabel": f"{sheet}-{batch}",
                    "sourceDate": date,
                    "fields": fields,
                })
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, indent=1)
    sizes = sum(1 for r in records if "基底尺寸" in r["fields"])
    print(f"{len(records)} batches with substrate fields; {sizes} with a normalized size")


if __name__ == "__main__":
    main()
