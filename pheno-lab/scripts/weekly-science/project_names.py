"""English display names bound to the frozen project's official label and its reviewed record."""
from collections import Counter
from html import escape
import unicodedata
import re

HAN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
# Exact vocabulary also covers recovered reports predating the reviewed name field.
# Removing the optional literal 组 only translates the group suffix, never its assignment.
TERMS = {
    "表征检测": "Characterization and Testing",
    "宽带隙电池与组件": "Wide-Bandgap Cells and Modules",
    "SAM 材料验证": "SAM Materials Validation",
    "基底产品开发与生产": "Substrate Product Development and Production",
    "材料合成": "Materials Synthesis",
}


def names_from_source(snapshot, bindings, decisions):
    inventory = {p["projectAlias"]: p.get("name") or p.get("projectName") for p in snapshot["projectInventory"]}
    if len(inventory) != len(snapshot["projectInventory"]):
        raise ValueError("Ambiguous project in source inventory")
    verdicts = {p["project"]: p for p in decisions["projects"]}
    if set(verdicts) != set(bindings) or set(inventory) != {p["projectAlias"] for p in bindings.values()}:
        raise ValueError("English labels require all source-bound projects")
    labels = []
    for key, binding in bindings.items():
        alias, name = binding["projectAlias"], binding["name"]
        if inventory[alias] != name or bool(alias) != bool(name):
            raise ValueError("Official project name differs from its frozen assignment")
        if not alias:
            english = "Unassigned experiments"
        else:
            base = name.removesuffix("组")
            english = ((TERMS[base] + (" Group" if base != name else "")) if base in TERMS
                       else verdicts[key].get("projectNameEn") or
                       (name if all(not c.isalpha() or "LATIN" in unicodedata.name(c, "") for c in name) else None))
            if (not isinstance(english, str) or not re.search(r"[A-Za-z]", english) or HAN.search(english)
                    or len(english) > 180 or re.search(r"[<>\n\r]|https?://|@", english)):
                raise ValueError("Missing reviewed English translation for a source project name")
        labels.append({"project": key, "sourceName": name, "english": english})
    counts = Counter(item["english"] for item in labels)
    for item in labels:
        if counts[item["english"]] > 1 and item["sourceName"] != item["english"]:
            item["english"] += " (" + item["sourceName"] + ")"
    return labels


def translate_project_names(doc, labels):
    """Translate human-facing English passages and evidence bindings together, leaving identifiers intact."""
    translated = {p["sourceName"]: p["english"] for p in labels if p["sourceName"] and p["sourceName"] != p["english"]}
    def translator(mapping):
        if not mapping:
            return lambda s: s
        pattern = re.compile(r"(?<![\u3400-\u9fff])(?:" + "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True)) + r")(?![\u3400-\u9fff])")
        return lambda s: pattern.sub(lambda m: mapping[m.group()], s)
    plain = translator(translated)
    html = translator({escape(k): escape(v) for k,v in translated.items()})
    def walk(row):
        if isinstance(row, list):
            for item in row: walk(item)
        if not isinstance(row, dict):
            return
        for key, value in row.items():
            if key == "bodyEn":
                # Preserve tag and attribute bytes, including anchors and chart geometry.
                parts = re.split(r"(<[^>]*>)", value)
                row[key] = "".join(html(s) if i % 2 == 0 else s for i,s in enumerate(parts))
            elif key == "en" or key.endswith("En"):
                if isinstance(value, str):
                    row[key] = plain(value)
                elif isinstance(value,list):
                    row[key] = [plain(s) if isinstance(s,str) else s for s in value]
            else:
                walk(value)
    walk(doc)
    sections = {s["id"]: s for s in doc["sections"]}
    # Existing manuscript versions used both short and long unassigned headings.
    if any(p["sourceName"] is None for p in labels):
        for section in ("projects","project-purposes"):
            for tag in ("td","h3"):
                sections[section]["bodyEn"] = sections[section]["bodyEn"].replace(
                    f"<{tag}>Unassigned</{tag}>", f"<{tag}>Unassigned experiments</{tag}>")
    # Show the canonical name next to the translation once; keep route headings and table cells short.
    for source, english in translated.items():
        title = "<h3>" + escape(english) + "</h3>"
        if sections["project-purposes"]["bodyEn"].count(title) != 1:
            raise ValueError("Project purpose heading lacks a unique source-bound English name")
        sections["project-purposes"]["bodyEn"] = sections["project-purposes"]["bodyEn"].replace(
            title, title + "<p>Recorded in Pheno Lab as " + escape(source) + "</p>", 1)


def verify_project_names(doc, labels):
    sections = {s["id"]: s for s in doc["sections"]}
    for item in labels:
        name = escape(item["english"])
        if ("<td>" + name + "</td>" not in sections["projects"]["bodyEn"] or
                any("<h3>" + name + "</h3>" not in sections[k]["bodyEn"] for k in ("routes", "project-purposes"))):
            raise ValueError("Missing English project name in the decision, route or purpose sections")
        if item["sourceName"] and item["sourceName"] != item["english"]:
            canonical = escape(item["sourceName"])
            if ("<p>Recorded in Pheno Lab as " + canonical + "</p>" not in sections["project-purposes"]["bodyEn"]
                    or any(canonical not in sections[k]["bodyZh"] for k in ("projects", "routes", "project-purposes"))):
                raise ValueError("Missing canonical project label in bilingual project sections")
