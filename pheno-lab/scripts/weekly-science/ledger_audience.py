"""Project restricted historical research into manager-safe status, with a private audit binding."""
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import re
import unicodedata


RESTRICTED = re.compile(
    r"chemist(?:ry)?[- ](?:review[- ])?only|for (?:the )?chemist(?:ry)? review only|"
    r"(?:private|restricted|confidential)[^.;。]{0,65}(?:analog|candidate|design|propos|synth|scaffold|route)|"
    r"(?:仅供|限于|只供).{0,14}(?:化学|合成)|(?:保密|受限|私有).{0,18}(?:候选|分子|化合物|骨架|方案)", re.I)
CODE = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9_-]*[0-9])[A-Z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9])")
SHORT_CANDIDATE = re.compile(r"(?:candidate|compound|analogue|代号|候选物|化合物)\s*[‘“\":：]?([A-Z][A-Za-z0-9]{1,12}\d[A-Za-z0-9]*)\b", re.I)
SCAFFOLD = re.compile(r"\b([A-Za-z][A-Za-z0-9]{1,18})[-‐‑–— ](derived|based|scaffold|lineage|series|analogu?e)\b", re.I)
STATUSES = {
    "no-new-direct-test": {"en": "No new experiment directly tested this restricted research proposal this week.",
                           "zh": "本周没有新实验直接检验这项受限研究建议。"},
    "partial-test": {"en": "This week’s experiment addressed part of the earlier research question. The chemistry team holds the proposal details.",
                     "zh": "本周实验检验了前期问题的一部分。方案详情由化学团队保管。"},
    "direct-test": {"en": "This week’s experiment directly addressed the earlier research question. The chemistry team holds the proposal details.",
                    "zh": "本周实验直接检验了前期问题。方案详情由化学团队保管。"},
}


def record_hash(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def match_text(text):
    normalized = unicodedata.normalize("NFKC", unescape(text)).casefold()
    return "".join(c for c in normalized if c.isalnum())


def narratives(row):
    for item in [row, *row.get("history", [])]:
        for key in ("statement", "decisionNote"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                yield value


class LedgerAudience:
    def __init__(self, records):
        self.restricted = set()
        self.identifiers = set()
        self.fingerprints = set()
        private_origin = set()
        for row in records:
            statements = list(narratives(row))
            marked = row.get("managerShareable") is False or row.get("visibility") in {"CHEMIST_ONLY","PRIVATE_CHEMISTRY"}
            explicit = [s for s in statements if RESTRICTED.search(s)]
            if not (marked or explicit):
                continue
            self.restricted.add(row["entryId"])
            private_origin.update(row.get("sourceReportIds", [])[:1])
            for text in (statements if marked else explicit):
                self.identifiers.update(match_text(x) for x in CODE.findall(text) + SHORT_CANDIDATE.findall(text))
                for found in SCAFFOLD.finditer(text):
                    stem = found[1]
                    self.fingerprints.add(match_text(found[0]))
                    if stem.lower() not in {"material","molecule","design","structure","proposed","new"}:
                        self.fingerprints.update(match_text(x) for x in (stem+"衍生",stem+"骨架","基于"+stem,"以"+stem+"为骨架"))
            for k in ("privateIdentifiers", "privateScaffoldLabels"):
                for term in row.get(k, []):
                    if isinstance(term, str) and term.strip():
                        self.identifiers.add(match_text(term))
        for row in records:
            # A legacy design memorandum may split its candidate, parent and controls
            # across entries. Keep the cluster private without withholding primary device data.
            if private_origin.intersection(row.get("sourceReportIds", [])[:1]):
                self.restricted.add(row["entryId"])
        self.fingerprints.update(self.identifiers)
        common = {match_text(note) for row in records if row["entryId"] not in self.restricted for note in narratives(row)}
        for row in records:
            if row["entryId"] in self.restricted:
                for note in narratives(row):
                    key = match_text(note)
                    if len(key) >= 32 and (key not in common or RESTRICTED.search(note)):
                        self.fingerprints.add(key)

    def matches(self, text):
        normalized = match_text(text)
        return any(term and term in normalized for term in self.fingerprints)

    def followup(self, entry_id, assessment, wording):
        if entry_id in self.restricted or any(self.matches(wording[lang]) for lang in ("en", "zh")):
            return STATUSES[assessment]
        return wording


class ManagerText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fragments = []
        self.block = []
        self.suppressed = 0

    def flush(self):
        if self.block:
            self.fragments.append("".join(self.block))
            self.block.clear()

    def handle_starttag(self, tag, attrs):
        if tag in {"style", "script"}:
            self.suppressed += 1
        if tag in {"p","section","li","td","th","h1","h2","h3","h4","caption","figcaption","text","title","desc"}:
            self.flush()
        if not self.suppressed:
            self.fragments.extend(v for k,v in attrs if v and (k in {"alt","title","aria-label","href"} or k.startswith("data-")))

    def handle_endtag(self, tag):
        if tag in {"p","section","li","td","th","h1","h2","h3","h4","caption","figcaption","text","title","desc"}:
            self.flush()
        if tag in {"style", "script"}:
            self.suppressed -= 1

    def handle_comment(self, data):
        self.fragments.append(data)

    def handle_data(self, data):
        if not self.suppressed:
            self.block.append(data)


def verify_manager_html(html, policy):
    parser = ManagerText()
    parser.feed(html)
    parser.close()
    parser.flush()
    joined = match_text("".join(parser.fragments))
    if (any(policy.matches(s) for s in parser.fragments)
            or any(term in joined for term in policy.identifiers if len(term) >= 6)):
        raise ValueError("Restricted historical research appears in manager-facing report text or link")
