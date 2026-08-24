#!/usr/bin/env python3
"""Survey the historical operator data and cross-reference it.

For every operator folder this reports:
  - the master sheet's three tabs (大面积 large-area / 小面积 small-area / 其他实验)
  - how many experiment batches and sample rows each holds
  - every JV CSV, classified by format, and the sample names inside it
  - how well master-sheet sample names line up with the JV files

Read-only. Nothing is written and nothing is staged.

Usage: python3 scripts/survey-historical.py [operator ...]
"""
import csv, datetime, io, os, re, sys, zipfile
from xml.etree import ElementTree as ET

ROOT = "/Users/michael/Documents/tutti/Perovskite Research Data Input/pheno-data/AI数据– Update/AI数据20260819"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


# ---------------------------------------------------------------- xlsx

def sheets_of(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"',
                           z.read("xl/_rels/workbook.xml.rels").decode()))
    out = []
    for s in wb.find(f"{NS}sheets"):
        t = rels[s.get(f"{REL}id")]
        out.append((s.get("name"), t if t.startswith("xl/") else "xl/" + t.lstrip("/")))
    return z, shared, out


def _col_num(col):
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def grid_of(z, shared, target):
    raw = z.read(target)
    root = ET.fromstring(raw)
    grid = {}
    for c in root.iter(f"{NS}c"):
        m = re.match(r"([A-Z]+)(\d+)", c.get("r"))
        col, ri = m.group(1), int(m.group(2))
        n = 0
        for ch in col:
            n = n * 26 + (ord(ch) - 64)
        v = c.find(f"{NS}v")
        t = c.get("t")
        if t == "s" and v is not None:
            val = shared[int(v.text)]
        elif v is not None:
            val = v.text
        else:
            continue
        val = (val or "").strip().replace("\n", " ")
        if val:
            grid.setdefault(ri, {})[n - 1] = val

    # Operators merge a batch's metadata down over its sample rows (Rose's
    # sheet alone has 756 merged ranges). Excel stores the value only in the
    # top-left cell, so without expanding them every row but the first looks
    # blank — and the batch loses all of its context.
    for ref in re.findall(rb'<mergeCell ref="([^"]+)"', raw):
        m = re.match(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", ref.decode())
        if not m:
            continue
        c1, r1, c2, r2 = _col_num(m.group(1)), int(m.group(2)), _col_num(m.group(3)), int(m.group(4))
        val = grid.get(r1, {}).get(c1 - 1)
        if val is None:
            continue
        for rr in range(r1, r2 + 1):
            for cc in range(c1, c2 + 1):
                grid.setdefault(rr, {}).setdefault(cc - 1, val)
    return grid


# ---------------------------------------------------------------- csv

def read_text(path, limit=400_000):
    raw = open(path, "rb").read(limit)
    for enc in ("utf-8-sig", "gb18030", "utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("latin-1", "replace")


def classify(path):
    """Return (format, [sample names]) for a JV csv."""
    try:
        txt = read_text(path)
    except Exception as e:
        return ("unreadable", [])
    head = txt[:4000]
    if "IV Test Report" in head:
        return ("raw-curve-blocks", [])
    rows = list(csv.reader(io.StringIO(txt)))
    if not rows:
        return ("empty", [])
    # GiantForce "Table" export: a metrics row per measurement.
    for i, r in enumerate(rows[:8]):
        if r and any(c.strip() == "Serial NO." for c in r):
            j = [k for k, c in enumerate(r) if c.strip() == "Serial NO."][0]
            names = [x[j].strip() for x in rows[i + 1:] if len(x) > j and x[j].strip()]
            return ("table-metrics", names)
    # Wide raw-curve export: repeating  Name,,<sample>  triples on row 1.
    if rows[0] and rows[0][0].strip() == "Name":
        names = [c.strip() for k, c in enumerate(rows[0]) if k % 3 == 2 and c.strip()]
        if names:
            return ("raw-curve-wide", names)
    return ("unknown", [])


# ---------------------------------------------------------------- keys

_EXCEL_EPOCH = datetime.date(1899, 12, 30)


def undate(s):
    """Undo Excel's silent conversion of sample names into dates.

    A sample called "1-6" is helpfully read by Excel as 6 January and stored as
    the serial 46028. Ian's whole small-area sheet is corrupted this way. Any
    bare integer in the plausible serial range is offered back as "M-D", which
    is how the JV exports name the same sample.
    """
    t = (s or "").strip()
    if not re.fullmatch(r"\d{5}", t):
        return None
    n = int(t)
    if not (40000 <= n <= 50000):
        return None
    d = _EXCEL_EPOCH + datetime.timedelta(days=n)
    return f"{d.month}-{d.day}"


def aliases(s):
    """Every key a written sample name could match on."""
    out = {norm(s)}
    u = undate(s)
    if u:
        out.add(norm(u))
    return {x for x in out if x}


def norm(s):
    """Compare sample names across the sheet/CSV naming conventions.

    A master sheet records the sample as "2018"; the JV export writes
    "2018-8-Rev" — the trailing "-8" is the sub-cell/pixel index and "-Rev" the
    scan direction. Both are measurement detail, not sample identity, so both
    are stripped. Without this Joey matched 2% of his samples; with it, 72%.
    """
    s = (s or "").strip().lower()
    s = s.replace("；", ";").replace("，", ",")
    s = re.sub(r"\.(pipentu|csv|zip)$", "", s)
    s = re.sub(r"[\s_;]+", "", s)
    # The sub-cell index is only stripped when a scan direction proves this is
    # a measurement label ("2018-8-Rev" → "2018"). Stripping unconditionally
    # would collapse genuinely distinct samples — Ian's 1-1, 1-2 and 1-6 would
    # all become "1".
    stripped = re.sub(r"-(rev|for|forward|reverse)$", "", s)
    if stripped != s:
        s = re.sub(r"-\d+$", "", stripped)
    return s


# Sheets that hold device (JV) experiments vs characterisation-only ones. A
# characterisation sheet legitimately has no JV files, so counting it in the
# match rate makes a healthy operator look broken (Barry read as 50%, but is
# 78% once his EDS/UV-Vis rows are excluded).
DEVICE_SHEETS = {"大面积", "小面积"}


def is_jv_csv(path):
    """EDS/instrument exports live beside JV data but are not JV data."""
    p = path.replace("\\", "/").lower()
    return not ("/export/" in p or os.path.basename(p).startswith("quantification"))


def main():
    wanted = sys.argv[1:]
    ops = sorted(d for d in os.listdir(ROOT)
                 if os.path.isdir(os.path.join(ROOT, d)) and d != "master definition list")
    if wanted:
        ops = [o for o in ops if o in wanted]

    for op in ops:
        base = os.path.join(ROOT, op)
        xlsx = []
        csvs = []
        for dirpath, _, files in os.walk(base):
            for f in files:
                p = os.path.join(dirpath, f)
                if f.startswith("~$") or f == ".DS_Store":
                    continue
                if f.lower().endswith(".xlsx"):
                    xlsx.append(p)
                elif f.lower().endswith(".csv"):
                    csvs.append(p)

        print("=" * 96)
        print(f"OPERATOR: {op}    xlsx:{len(xlsx)}  csv:{len(csvs)}")

        # --- master sheets
        master_names = set()
        batches = set()
        for x in xlsx:
            try:
                z, shared, sh = sheets_of(x)
            except Exception as e:
                print(f"  [xlsx unreadable] {os.path.basename(x)}: {e}")
                continue
            names = [s[0] for s in sh]
            is_master = "大面积" in names or "小面积" in names
            tag = "MASTER" if is_master else "other "
            print(f"  [{tag}] {os.path.relpath(x, base)}  sheets={names}")
            if not is_master:
                continue
            for sname, tgt in sh:
                g = grid_of(z, shared, tgt)
                if len(g) < 2:
                    print(f"      {sname}: empty")
                    continue
                hdr_ri = min(g)
                hdr = g[hdr_ri]
                col = {v: k for k, v in hdr.items()}
                ci_name = col.get("Name")
                ci_serial = col.get("Serial NO.")
                ci_raw = col.get("原始数据编号")
                ci_batch = col.get("实验批次编号")
                ci_purpose = col.get("实验目的")
                ci_concl = col.get("实验结论")
                data = [g[r] for r in sorted(g) if r != hdr_ri]
                sn = set()
                for r in data:
                    for ci in (ci_name, ci_serial, ci_raw):
                        if ci is not None and ci in r:
                            sn.add(r[ci])
                bs = {r[ci_batch] for r in data if ci_batch is not None and ci_batch in r}
                withp = sum(1 for r in data if ci_purpose is not None and r.get(ci_purpose))
                withc = sum(1 for r in data if ci_concl is not None and r.get(ci_concl))
                if sname in DEVICE_SHEETS:
                    master_names |= sn
                batches |= {(sname, b) for b in bs}
                kind = "device" if sname in DEVICE_SHEETS else "charact."
                print(f"      {sname}: {len(data)} rows | batches={len(bs)} | sample-names={len(sn)} [{kind}]"
                      f" | rows with 实验目的={withp} 实验结论={withc}")

        # --- csv formats + names
        fmt_count = {}
        csv_names = set()
        per_file = []
        for p in csvs:
            if not is_jv_csv(p):
                fmt_count["eds/export (skipped)"] = fmt_count.get("eds/export (skipped)", 0) + 1
                continue
            f, names = classify(p)
            fmt_count[f] = fmt_count.get(f, 0) + 1
            csv_names |= set(names)
            per_file.append((p, f, names))
        print(f"  CSV formats: {fmt_count}")
        print(f"  distinct sample names — master:{len(master_names)}  csv:{len(csv_names)}")

        if master_names and csv_names:
            c = {k for x in csv_names for k in aliases(x)}
            for p, f, _ in per_file:
                mm = re.match(r"(.+?)_[A-Za-z]+_(Table|Data)_\d+", os.path.basename(p))
                if mm:
                    c |= aliases(mm.group(1))
            m = {norm(x) for x in master_names if norm(x)}
            both = {x for x in m if aliases(x) & c}
            print(f"  MATCH: {len(both)} names in both"
                  f" | only in master: {len(m - c)} | only in csv: {len(c - m)}")
            if both:
                print(f"    e.g. matched: {sorted(both)[:6]}")
            if m - c:
                print(f"    e.g. master-only: {sorted(m - c)[:6]}")
            if c - m:
                print(f"    e.g. csv-only: {sorted(c - m)[:6]}")
        # filename-derived keys (Cindy pattern: <sample>_<op>_Table_<ts>.csv)
        fn_keys = set()
        for p, f, _ in per_file:
            b = os.path.basename(p)
            mm = re.match(r"(.+?)_[A-Za-z]+_(Table|Data)_\d+", b)
            if mm:
                fn_keys.add(norm(mm.group(1)))
        if fn_keys:
            hit = len(fn_keys & {norm(x) for x in master_names})
            print(f"  filename sample keys: {len(fn_keys)} | also in master sheet: {hit}")


if __name__ == "__main__":
    main()
