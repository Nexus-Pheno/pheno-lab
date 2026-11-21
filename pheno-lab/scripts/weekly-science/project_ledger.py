"""Project-level publication of previously recorded questions, bound to both ledger versions."""

from collections import Counter
from html import escape
import re

from ledger_audience import (
    ManagerText,
    match_text,
    narratives,
    record_hash,
    CODE,
    SHORT_CANDIDATE,
)

STYLE = "PROJECT_STATUS_REGISTER_V1"
SID = "prior-action-review"
RANK = {"no-new-direct-test": 0, "partial-test": 1, "direct-test": 2}
LANG = ("en", "zh")


def unique(items, field):
    rows = {r[field]: r for r in items}
    if len(rows) != len(items):
        raise ValueError("Duplicate prior-question source binding")
    return rows


def register(previous, current, bindings, decisions, receipts, index, labels, evidence):
    old = unique(previous["ledgerEntries"], "entryId")
    new = unique(current["ledgerEntries"], "entryId")
    signed = unique(receipts["projects"], "project")
    case_assessments = {}
    for a in index["followupAssessments"]:
        case_assessments.setdefault(a["entryId"], []).append(a)
    detail = {c["binding"]["experimentCode"]: c["sectionId"] for c in index["cases"]}
    groups = []
    issues = []
    coverage = set()
    texts = unique(labels, "project")
    if (
        set(texts) != set(bindings["projects"])
        or set(texts) != set(signed)
        or set(texts) != set(unique(decisions["projects"], "project"))
    ):
        raise ValueError("Incomplete project assessment coverage")
    for p in decisions["projects"]:
        key = p["project"]
        alias = bindings["projects"][key]["projectAlias"] or "UNASSIGNED"
        ids = unique(signed[key]["issueBindings"], "key")
        if set(ids) != set(unique(p["issueAssessments"], "key")):
            raise ValueError(
                "Prior-question review differs from its signed project binding"
            )
        records = []
        project_issues = []
        for a in p["issueAssessments"]:
            ident = ids[a["key"]]["entryId"]
            before, after = old[ident], new[ident]
            if (
                ident in coverage
                or any(
                    (e["projectAlias"] or "UNASSIGNED") != alias
                    for e in (before, after)
                )
                or after["history"][: len(before["history"])] != before["history"]
            ):
                raise ValueError(
                    "Prior-question assignment or append-only history mismatch"
                )
            coverage.add(ident)
            status = a["assessment"]
            codes = set(a["testedExperimentCodes"])
            if (not codes) != (RANK[status] == 0):
                raise ValueError("Project follow-up test missing its reviewed source")
            for case in case_assessments.get(ident, []):
                if RANK[case["assessment"]] > 0:
                    codes.add(bindings["cases"][case["experiment"]]["code"])
                    if RANK[case["assessment"]] > RANK[status]:
                        status = case["assessment"]
            changed = before != after
            evidence_ids = (
                [
                    x
                    for x in after["history"][-1]["evidenceIdentifiers"]
                    if x in evidence
                ]
                if changed
                else []
            )
            if changed and not evidence_ids:
                raise ValueError("Updated prior question lacks source evidence")
            if codes - evidence:
                raise ValueError("Previous-question test cites an unknown experiment")
            records.append(
                dict(
                    entryId=ident,
                    baselineSha256=record_hash(before),
                    currentSha256=record_hash(after),
                    assessmentSha256=record_hash([a, *case_assessments.get(ident, [])]),
                    testStatus=status,
                    updated=changed,
                    testedCodes=sorted(codes),
                )
            )
            project_issues.append(
                dict(
                    entryId=ident,
                    sectionId=SID,
                    currentStatus=after["status"],
                    revision=after["revision"],
                    assessment="REVIEWED_UPDATE"
                    if changed
                    else "UNCHANGED_NO_NEW_EVIDENCE",
                    executionStatus="NOT_VERIFIED",
                    evidenceIds=evidence_ids,
                )
            )
        counted = Counter(r["testStatus"] for r in records)
        name = {
            "en": texts[key]["english"],
            "zh": texts[key]["sourceName"] or "未分配项目的实验",
        }
        row = dict(
            projectAlias=alias,
            project=key,
            names=name,
            total=len(records),
            noNew=counted["no-new-direct-test"],
            partial=counted["partial-test"],
            direct=counted["direct-test"],
            updated=sum(r["updated"] for r in records),
            records=records,
            caseLinks=[
                dict(code=code, section=detail.get(code, "sources"))
                for code in sorted({code for r in records for code in r["testedCodes"]})
            ],
        )
        groups.append(row)
        for item in project_issues:
            item.update(analysisEn=summary(row, "en"), analysisZh=summary(row, "zh"))
        issues.extend(project_issues)
    if coverage != set(old) or not set(case_assessments).issubset(coverage):
        raise ValueError(
            "Every prior question must have exactly one source-bound project assessment"
        )
    scope = dict(
        presentation=STYLE,
        projectRows=groups,
        selectedEntryIds=[r["entryId"] for r in issues],
        newEntryIds=sorted(set(new) - set(old)),
        omittedUnchangedCount=0,
        selectionReasonEn="All previous questions are counted once under their recorded project.",
        selectionReasonZh="全部前期问题按原项目归类，每项仅计一次。",
    )
    return scope, issues


def summary(g, lang):
    if lang == "en":
        return (
            f"{g['total']} earlier questions. No new direct test: {g['noNew']}. Partly tested: {g['partial']}. "
            f"Directly tested: {g['direct']}. Ledger entries updated: {g['updated']}."
        )
    return f"前期问题 {g['total']} 项。本周无新直接验证 {g['noNew']} 项，部分验证 {g['partial']} 项，直接验证 {g['direct']} 项。记录有更新 {g['updated']} 项。"


def body(scope, lang):
    total = sum(g["total"] for g in scope["projectRows"])
    new_count = len(scope["newEntryIds"])
    start = (
        f"This table tracks all {total} questions from the previous report. This week’s report adds {new_count} new entries separately."
        if lang == "en"
        else f"本表跟踪上期延续的全部 {total} 项问题。本周另新增 {new_count} 条记录。"
    )
    head = ("Project", "Progress this week") if lang == "en" else ("项目", "本周进展")
    rows = []
    for i, g in enumerate(scope["projectRows"], 1):
        links = "".join(
            f' <a href="#{escape(link["section"])}">{("Reviewed evidence for " if lang == "en" else "复核依据：实验 ")}{escape(link["code"])}</a>'
            for link in g["caseLinks"]
        )
        rows.append(
            f'<tr><td><a href="#prior-project-{lang}-{i}">{escape(g["names"][lang])}</a></td><td>{escape(summary(g, lang))}{links}</td></tr>'
        )
    return (
        f'<p>{start}</p><div class="table-wrap"><table><thead><tr><th>{head[0]}</th><th>{head[1]}</th></tr></thead><tbody>'
        + "".join(rows)
        + "</tbody></table></div>"
    )


def add_to_sections(sections, scope):
    sections[SID] = {
        "id": SID,
        "titleEn": "Progress on earlier research questions",
        "titleZh": "前期研发问题的进展",
    }
    for lang in LANG:
        field = "body" + lang.title()
        sections[SID][field] = body(scope, lang)
        expected = iter(enumerate(scope["projectRows"], 1))

        def project_row(m):
            i, row = next(expected)
            cells = re.findall(r"<td>.*?</td>", m[1], re.S)
            if (
                len(cells) != 5
                or cells[0]
                != "<td>"
                + escape(
                    (
                        row["names"]["zh"]
                        if row["projectAlias"] != "UNASSIGNED"
                        else ("Unassigned" if lang == "en" else "未分配")
                    )
                )
                + "</td>"
            ):
                raise ValueError(
                    "Project summary table differs from reviewed project names or order"
                )
            label = (
                f"{row['total']} earlier questions"
                if lang == "en"
                else f"{row['total']} 项前期问题"
            )
            cells[2] = f'<td><a href="#{SID}">{label}</a></td>'
            return f'<tr id="prior-project-{lang}-{i}">' + "".join(cells) + "</tr>"

        intro, tbody = sections["projects"][field].split("<tbody>", 1)
        table, tail = tbody.split("</tbody>", 1)
        table = re.sub(r"<tr>(.*?)</tr>", project_row, table, flags=re.S)
        if next(expected, None) is not None:
            raise ValueError("Project summary table is missing a reviewed project")
        sections["projects"][field] = intro + "<tbody>" + table + "</tbody>" + tail


def verify_view(document, scope, prior, current):
    sections = unique(document["sections"], "id")
    old = unique(prior["ledgerEntries"], "entryId") if prior is not None else None
    new = unique(current["ledgerEntries"], "entryId")
    rows = scope["projectRows"]
    if {g["projectAlias"] for g in rows} != {
        r["projectAlias"] or "UNASSIGNED" for r in current["projects"]
    }:
        raise ValueError("Missing project in historical question register")
    entries = [r for g in rows for r in g["records"]]
    historic = unique(entries, "entryId")
    if (
        len({g["projectAlias"] for g in rows}) != len(rows)
        or set(scope["newEntryIds"]) != set(new) - set(historic)
        or old is not None
        and set(old) != set(historic)
    ):
        raise ValueError(
            "Historical register is incomplete or misclassifies new proposals"
        )
    if any(
        r["currentSha256"] != record_hash(new[k])
        or old is not None
        and r["baselineSha256"] != record_hash(old[k])
        for k, r in historic.items()
    ):
        raise ValueError("Historical register source digest differs")
    for i, g in enumerate(rows, 1):
        vals = Counter(r["testStatus"] for r in g["records"])
        if set(vals) - set(RANK) or (
            len(g["records"]),
            vals["no-new-direct-test"],
            vals["partial-test"],
            vals["direct-test"],
            sum(r["updated"] for r in g["records"]),
        ) != (g["total"], g["noNew"], g["partial"], g["direct"], g["updated"]):
            raise ValueError("False historical question status counts")
        for lang in LANG:
            if (
                sections["projects"]["body" + lang.title()].count(
                    f'id="prior-project-{lang}-{i}"'
                )
                != 1
            ):
                raise ValueError("Missing unique project row target")
        if any(x["section"] not in sections for x in g["caseLinks"]):
            raise ValueError("Historical test link has no corresponding case or source")
    for lang in LANG:
        if sections[SID]["body" + lang.title()] != body(scope, lang):
            raise ValueError(
                "Visible history register must match signed project counts and links"
            )


class HistoricalWording:
    """Exclude past laboratory narratives, identifiers and dose-level discussion from the history appendix."""

    def __init__(self, prior):
        self.notes = set()
        self.codes = set()
        for entry in prior["ledgerEntries"]:
            for text in narratives(entry):
                normalized = match_text(text)
                if len(normalized) >= 40:
                    self.notes.add(normalized)
                self.codes.update(CODE.findall(text) + SHORT_CANDIDATE.findall(text))
        self.tokens = [
            re.compile(r"(?<![a-z0-9])" + re.escape(c) + r"(?![a-z0-9])", re.I)
            for c in self.codes
        ]

    def needs_projection(self, text):
        normalized = match_text(text)
        return (
            any(n in normalized for n in self.notes)
            or any(p.search(text) for p in self.tokens)
            or re.search(
                r"\d+(?:\.\d+)?(?:\s*[/、–~～]\s*\d+(?:\.\d+)?){2,}|\d+(?:\.\d+)?\s*(?:mg\s*/\s*m[lL]|mM\b|mol\s*/\s*L|wt\s*%)",
                text,
                re.I,
            )
        )

    def pair(self, text, purpose=None):
        if any(self.needs_projection(t) for t in text.values()):
            if purpose and not any(self.needs_projection(t) for t in purpose.values()):
                return purpose
            return {
                "en": "The full historical comparison is recorded on the experiment page.",
                "zh": "该项历史比较的具体内容见原实验记录。",
            }
        return text

    def verify(self, html, document=None):
        # Public primary cases may use a reviewed material code. The history appendices
        # have no authority to introduce candidate labels from past proposals themselves.
        if document is not None:
            sections = unique(document["sections"], "id")
            primary = {
                r["sectionId"] for r in document["evidenceMethodReview"]["experiments"]
            }

            def fragments(section_ids):
                parser = ManagerText()
                for sid in section_ids:
                    for l in ("En", "Zh"):
                        parser.feed(sections[sid]["body" + l])
                        parser.flush()
                parser.close()
                return "\n".join(parser.fragments)

            reviewed_current = fragments(primary)
            public_history = fragments(("context", "project-purposes", SID))
            if any(
                token.search(public_history) and not token.search(reviewed_current)
                for token in self.tokens
            ):
                raise ValueError(
                    "Historical appendix reintroduces a prior-only candidate identifier"
                )

        p = ManagerText()
        p.feed(html)
        p.close()
        p.flush()
        blocks = [match_text(t) for t in p.fragments]
        joined = "".join(blocks)
        if any(note in joined for note in self.notes):
            raise ValueError(
                "Original historical ledger text appears in the manager report"
            )
