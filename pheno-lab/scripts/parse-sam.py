#!/usr/bin/env python3
"""Stage Bruce's SAM library into the quality gate.

    python3 scripts/parse-sam.py [--out FILE]
    node scripts/stage-ingest.js --file FILE

Three sources:
  p-SAM_Literature/p-SAM_Literature.md  — 202 published SAMs, 41 fields
  p-SAM_Pheno/SAM结构效率.xlsx           — 85 molecules across five series
  n-SAM_Pheno/n-SAM_Pheno.md            — 51 in-house n-SAMs

CONFIDENTIALITY. The CELL, XP, Y, RS and n-SAM series are Pheno's own
molecules. Their structures never enter an IngestItem: the SMILES and
composition are dropped HERE, at staging, not filtered later at publish time
where a reviewer could approve one by accident. `assert_secret_clean` re-checks
every item before it is written, so a future edit to this file cannot leak a
structure silently.

These are best-recorded efficiencies with little experimental context, so they
are staged as MATERIAL properties, not as experiments.
"""
import argparse, json, os, re, sys, zipfile
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from importlib.machinery import SourceFileLoader
sv = SourceFileLoader("sv", os.path.join(HERE, "survey-historical.py")).load_module()

SAM_ROOT = "/Users/michael/Documents/tutti/Perovskite Research Data Input/pheno-data/SAM Data"

# Series whose molecular structure must never be published.
SECRET_SERIES = {"CELL系列", "XP系列", "Y系列", "RS系列"}
SECRET_PREFIX = re.compile(r"^\s*(cell|xp|y|rs|nc|n-?sam|hydra)[\s\-_]*\d", re.I)


def is_secret(name, series):
    return series in SECRET_SERIES or series == "n-SAM" or bool(SECRET_PREFIX.match(name or ""))


def assert_secret_clean(items):
    """Belt and braces: no confidential molecule may carry a structure."""
    for it in items:
        p = it["payload"]
        if p.get("_secret") and (p.get("smiles") or p.get("composition")):
            raise SystemExit(f"CONFIDENTIALITY BREACH: {p['name']} carries a structure")
    return items


def md_table(path, header_contains):
    """Rows of the first markdown table whose header contains a given column."""
    rows, hdr = [], None
    for line in open(path, encoding="utf-8"):
        if not line.startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
        if set("".join(cells)) <= set("-: "):
            continue
        if hdr is None:
            if header_contains in cells:
                hdr = cells
            continue
        if len(cells) == len(hdr):
            rows.append(dict(zip(hdr, cells)))
    return rows


def val(v):
    v = (v or "").strip()
    return "" if v.upper() in {"NA", "N/A", "", "-"} else v


def parse_pheno_xlsx():
    """The transposed workbook: molecules are columns, properties are rows."""
    path = os.path.join(SAM_ROOT, "p-SAM_Pheno", "SAM结构效率.xlsx")
    z, shared, sheets = sv.sheets_of(path)
    out = []
    for series, tgt in sheets:
        g = sv.grid_of(z, shared, tgt)
        if not g:
            continue
        # Walk blocks: a 名称 row starts one, and the rows beneath it up to the
        # next 名称 row carry that block's properties.
        order = sorted(g)
        blocks = [i for i in order if g[i].get(0) == "名称"]
        for bi, start in enumerate(blocks):
            end = blocks[bi + 1] if bi + 1 < len(blocks) else order[-1] + 1
            names = {c: v for c, v in g[start].items() if c >= 2 and v}
            prop = {}
            section = ""
            for r in order:
                if not (start < r < end):
                    continue
                lab = g[r].get(0, "")
                sub = g[r].get(1, "")
                if lab in ("分层涂", "共沉积", "共沉积/分步涂"):
                    section = lab
                key = (f"{section}:{sub}" if sub else lab) or (f"{section}:{sub}")
                if not key.strip(":"):
                    continue
                prop[key] = {c: v for c, v in g[r].items() if c >= 2 and v}
            for col, name in names.items():
                name = name.strip()
                if not name:
                    continue
                secret = is_secret(name, series)
                props = {}
                for key, cells in prop.items():
                    v = val(cells.get(col, ""))
                    if not v or key in ("名称",):
                        continue
                    if key == "Smiles":
                        continue
                    label = {
                        "LUMO(eV)": "LUMO (eV)", "HOMO(eV)": "HOMO (eV)",
                        "分层涂:Voc": "Sequential Voc (V)", "分层涂:Jsc": "Sequential Jsc (mA/cm²)",
                        "分层涂:FF": "Sequential FF (%)", "分层涂:PCE": "Sequential PCE (%)",
                        "共沉积:Voc": "Co-deposited Voc (V)", "共沉积:Jsc": "Co-deposited Jsc (mA/cm²)",
                        "共沉积:FF": "Co-deposited FF (%)", "共沉积:PCE": "Co-deposited PCE (%)",
                    }.get(key)
                    if label:
                        props[label] = v
                props["Series"] = series
                props["Source"] = "Bruce — SAM结构效率.xlsx"
                smiles = "" if secret else val(prop.get("Smiles", {}).get(col, ""))
                out.append({
                    "name": name, "series": series, "secret": secret,
                    "smiles": smiles, "properties": props,
                })
    return out


def parse_nsam():
    path = os.path.join(SAM_ROOT, "n-SAM_Pheno", "n-SAM_Pheno.md")
    rows = md_table(path, "SAM")
    out = []
    for r in rows:
        name = val(r.get("SAM"))
        if not name:
            continue
        props = {"Series": "n-SAM", "Source": "Bruce — n-SAM_Pheno.md"}
        for src, label in (
            ("Avg Voc (V)", "Avg Voc (V)"), ("Avg Jsc (mA cm^-2)", "Avg Jsc (mA/cm²)"),
            ("Avg FF (%)", "Avg FF (%)"), ("Avg PCE (%)", "Avg PCE (%)"),
            ("n batches", "Batches"), ("n devices", "Devices"),
            ("Status", "Status"), ("Reference", "Reference cell"), ("Comment", "Comment"),
        ):
            v = val(r.get(src))
            if v:
                props[label] = v
        out.append({"name": name, "series": "n-SAM", "secret": True, "smiles": "", "properties": props})
    return out


def parse_literature():
    path = os.path.join(SAM_ROOT, "p-SAM_Literature", "p-SAM_Literature.md")
    rows = md_table(path, "SAMName")
    out = []
    for r in rows:
        name = val(r.get("SAMName"))
        if not name:
            continue
        props = {"Series": "Literature", "Source": "p-SAM_Literature Database"}
        for src, label in (
            ("SAMFullName", "Full name"), ("SAMCAS", "CAS"), ("Year", "Year"),
            ("ResearchGroup", "Research group"), ("ExpHOMO", "HOMO exp (eV)"),
            ("ExpLUMO", "LUMO exp (eV)"), ("CalcHOMO", "HOMO calc (eV)"),
            ("CalcLUMO", "LUMO calc (eV)"), ("RevPCE", "Best PCE (%)"),
            ("RevVoc", "Voc (V)"), ("RevJSc", "Jsc (mA/cm²)"), ("RevFF", "FF (%)"),
            ("HysteresisIndex", "Hysteresis index"), ("DipoleMoment", "Dipole moment"),
            ("BindingEnergy(eV)", "Binding energy (eV)"), ("ContactAngle", "Contact angle (°)"),
            ("Thickness(nm)", "Thickness (nm)"), ("RMS(nm)", "RMS roughness (nm)"),
            ("PVSK", "Perovskite"), ("Area(cm2)", "Area (cm²)"), ("Reference", "Reference"),
        ):
            v = val(r.get(src))
            if v:
                props[label] = v
        out.append({
            "name": name, "series": "Literature", "secret": False,
            "smiles": val(r.get("SAMSMILES")),
            "casNumber": val(r.get("SAMCAS")),
            "properties": props,
        })
    return out


def main(out_path):
    mols = parse_literature() + parse_pheno_xlsx() + parse_nsam()

    # De-duplicate within the batch, preferring the entry that carries more.
    best = {}
    for m in mols:
        k = sv.norm(m["name"])
        if not k:
            continue
        cur = best.get(k)
        if cur is None or len(m["properties"]) > len(cur["properties"]):
            best[k] = m

    items = []
    for m in best.values():
        secret = m["secret"]
        items.append({
            "kind": "MATERIAL",
            "title": m["name"],
            "sourceFile": f"SAM Data ({m['series']})",
            "confidence": (
                "Confidential in-house molecule — structure and composition deliberately "
                "omitted; only name, energy levels and best recorded efficiencies staged."
                if secret else
                "SAM reference data from Bruce's library. Efficiencies are best recorded "
                "values with limited experimental context, stored as material properties."
            ),
            "payload": {
                "name": m["name"],
                "category": "SAM",
                "composition": "",
                "smiles": "" if secret else m.get("smiles", ""),
                "casNumber": "" if secret else m.get("casNumber", ""),
                "molecularWeight": "", "purity": "", "supplier": "", "lot": "",
                "properties": m["properties"],
                "notes": "",
                "_secret": secret,
            },
        })

    assert_secret_clean(items)
    for it in items:
        it["payload"].pop("_secret", None)

    with open(out_path, "w") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    ns = sum(1 for m in best.values() if m["secret"])
    print(f"{len(items)} SAM material(s) -> {out_path}")
    print(f"  structure-suppressed: {ns}   with SMILES: {sum(1 for i in items if i['payload']['smiles'])}")
    return items


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/ingest-sam.json")
    main(ap.parse_args().out)
