"""Keep a comparison's material role while withholding reconstructive scientific names."""
from html import escape, unescape
import re

from ledger_audience import ManagerText, match_text

HAN = re.compile(r"[\u3400-\u9fff]")
LOCANT = re.compile(r"\d[,′'\d]*[-‐‑‒–—]|[-‐‑‒–—]\d\b")
CHEM = re.compile(r"benz|phenyl|phenol|pyrid|thiophen|triaz|thiaz|phosph|carbox|sulfon|fluoro|chloro|bromo|amino|ammon|methyl|ethyl|hydroxy|imidaz|naphth|cyclohex|oxazol|piperid|acetyl|hydraz|indol|pyrrol|酸|苯|基|胺|铵|咪唑|吡啶|噻|磺|嘧啶|咔唑|羧|膦|芴|萘", re.I)
# Require positional nomenclature in prose; match only chemically meaningful suffix words.
EN_LOCATED = re.compile(r"(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9′'(),-]*-\d[\d,′'()-]*-|\d[\d,′']*-)[A-Za-z][A-Za-z0-9,′'()-]+(?:\s+(?:acid|(?:[a-z]+)?(?:chloride|bromide|iodide|fluoride|phosphate|sulfate|sulfonate|hydrate|carboxylate)))?\b(?:\s+(?:[a-z]+)?(?:chloride|bromide|iodide|fluoride|phosphate|sulfate|sulfonate|hydrate|carboxylate)\b)?", re.I)
ROLE_EN = re.compile(r"^\s+(SAM[ -]additive|passivation additive|passivant|additive|surface treatment|interlayer|modifier|SAM)\b", re.I)
ROLE_ZH = re.compile(r"^\s*((?:SAM\s*)?(?:添加剂|钝化剂|修饰剂|处理材料)|SAM)(?![a-zA-Z])", re.I)


def systematic(name):
    if not isinstance(name, str) or len(name) < 6 or len(name) > 600:
        return False
    clues = set(w.casefold() for w in CHEM.findall(name))
    return bool(clues and LOCANT.search(name) or len(clues) >= 2 and len(name) >= (12 if HAN.search(name) else 22))


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value: yield from strings(item)
    elif isinstance(value, dict):
        for item in value.values(): yield from strings(item)


def source_names(snapshot, project_decisions):
    names = set()
    for item in snapshot.get("privateChemistryDefinitions", []):
        if systematic(item.get("name")): names.add(item["name"])
    inventory = {x["code"]: x for x in snapshot["experimentSummaries"]}
    translated = {k: [] for k in inventory}
    for proj in project_decisions["projects"]:
        for intent in proj["routeIntents"]:
            code = intent["experimentCode"]
            if code in translated:
                translated[code].append(intent)
    for code, row in inventory.items():
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        plan = metadata.get("testPlan")
        variables = plan.get("variables") if isinstance(plan,dict) else None
        values = set()
        for var in variables if isinstance(variables,list) else []:
            if isinstance(var,dict) and var.get("kind") == "material":
                values.update(s for s in strings(var.get("values")) if systematic(s))
        names.update(values)
        narrative = [row.get(k) or "" for k in ("title","observation","hypothesis","problem","conclusion")]
        if not values and not any(n in text for text in narrative for n in names):
            continue
        # An optional source translation locates a spelling only. Its judgment and measurements are never reused.
        for text in strings([narrative, metadata.get("aiSummary"), translated[code]]):
            for m in EN_LOCATED.finditer(text):
                value = m.group().rstrip(",;.")
                if systematic(value):
                    names.add(value)
    return sorted(names, key=len, reverse=True)


class ManagerMaterialNames:
    def __init__(self, snapshot, decisions):
        self.names = source_names(snapshot, decisions)
        self.fingerprints = {match_text(n) for n in self.names}
        self.pattern = re.compile("|".join(re.escape(n) for n in self.names),re.I) if self.names else None

    def text(self, text, lang):
        if lang == "zh":
            text = re.sub(r"(?<![A-Za-z0-9_])currentAccepted(?![A-Za-z0-9_])", "系统采纳的器件结果", text)
        if not self.pattern:
            return text
        parts = []
        end = 0
        for m in self.pattern.finditer(text):
            if m.start() < end:
                continue
            before, after = text[end:m.start()], text[m.end():]
            role = (ROLE_EN if lang=="en" else ROLE_ZH).match(after)
            if lang == "en":
                # A condition explicitly naming a role retains it. Otherwise use the neutral observed entity.
                prefix = "selected " if re.search(r"\b(?:a|an|the|this|that|its)\s+$", before, re.I) else "the selected "
                if re.search(r"\ban\s+$", before, re.I):
                    before=re.sub(r"\ban\s+$","a ",before,flags=re.I)
                substitution = prefix + (role[1] if role else "material")
            else:
                substitution = ("所选 " if role and role[1].upper().startswith("SAM") else "所选") + (role[1] if role else "材料")
            parts.extend((before, substitution))
            end = m.end() + (len(role[0]) if role else 0)
        return "".join(parts) + text[end:]

    def project(self, doc):
        def rewrite(value, lang):
            if isinstance(value,str): return self.text(value,lang)
            if isinstance(value,list): return [rewrite(v,lang) for v in value]
            return value
        def visit(row):
            if isinstance(row,list):
                for item in row: visit(item)
            elif isinstance(row,dict):
                for key,val in row.items():
                    if key in ("bodyEn","bodyZh"):
                        parts=re.split(r"(<[^>]*>)",val)
                        for i in range(0,len(parts),2):
                            raw=unescape(parts[i]);out=self.text(raw,key[-2:].lower())
                            if raw!=out: parts[i]=escape(out)
                        row[key]="".join(parts)
                    elif key in ("en","zh") or key.endswith(("En","Zh")):
                        row[key]=rewrite(val,key[-2:].lower())
                    else:
                        visit(val)
        visit(doc)

    def verify(self, html):
        p=ManagerText(); p.feed(html); p.close(); p.flush()
        visible=[match_text(x) for x in p.fragments]
        joined="".join(visible)
        if any(n in joined for n in self.fingerprints):
            raise ValueError("A reconstructive material name from the frozen source remains in manager-facing content")
        if any(systematic(m.group()) for text in p.fragments for m in EN_LOCATED.finditer(text)):
            raise ValueError("A positional chemical name needs a reviewed nonreconstructive material description")
