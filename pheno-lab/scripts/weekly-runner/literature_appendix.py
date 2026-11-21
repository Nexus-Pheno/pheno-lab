"""Render local and published sources separately using reviewed, bounded study notes."""

from hashlib import sha256
from html import escape
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-manuscript"))
from private_science import reviewed_article

SHA = re.compile(r"[a-f0-9]{64}\Z")
DOI = re.compile(r"10\.\d{4,9}/[-._;()/:a-zA-Z0-9]+\Z")


def digest(value):
    return sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def keyed(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows):
        raise ValueError("Duplicate literature or experiment source")
    return result


def wording(item):
    if set(item) != {"en", "zh"} or any(
        not isinstance(v, str) or not v.strip() or len(v) > 900 for v in item.values()
    ):
        raise ValueError("Missing source explanation in one of the report languages")
    return item


def bound_notes(work, science, articles):
    if science.get("literatureNotes"):
        return science["literatureNotes"]
    # Earlier verified manuscripts have an immutable scientific interpretation.
    # A named editor may supplement its literature interpretation for the final
    # independent manuscript referee. Require the exact unmodified frozen inputs.
    sidecar = read(work / "literature-editorial-notes.private.json")
    if (
        sidecar.get("schemaVersion") != 1
        or sidecar.get("classification") != "UNPUBLISHED_EDITORIAL_SOURCE_NOTES"
        or not sidecar.get("preparedBy")
    ):
        raise ValueError("Unattributed historical literature supplement")
    if (
        sidecar["interpretationSha256"]
        != sha256((work / "science-interpretation.json").read_bytes()).hexdigest()
    ):
        raise ValueError(
            "The literature supplement addresses a different scientific manuscript"
        )
    if sidecar["articleRecords"] != {
        a["paper"]: digest({k: a[k] for k in ("doi", "title", "abstract")})
        for a in articles
    }:
        raise ValueError("Historical source abstracts changed")
    case_rows = keyed(science["cases"], "experiment")
    if sidecar["caseSources"] != {k: v["sourceHash"] for k, v in case_rows.items()}:
        raise ValueError(
            "Historical literature notes are not bound to this case selection"
        )
    expected = {
        (k, id_) for k, c in case_rows.items() for id_ in c["chemical"]["sources"]
    }
    bound = set()
    for use in sidecar["scientificLimitations"]:
        k, id_ = use["experiment"], use["paper"]
        if (
            (k, id_) in bound
            or (k, id_) not in expected
            or use["sha256"]
            not in {
                sha256(s.encode()).hexdigest()
                for s in case_rows[k]["chemical"]["limitations"]
            }
        ):
            raise ValueError(
                "Historical use has no matching scientific review limitation"
            )
        bound.add((k, id_))
    if bound != expected:
        raise ValueError(
            "Historical literature use coverage differs from scientific review"
        )
    return sidecar["notes"]


def source_appendix(work, cases, science, articles, app):
    private = read(work / "private-scientific-facts.json")
    private_papers = keyed(private["articles"], "id")
    refreshed = keyed(articles, "paper")
    if set(private_papers) != set(refreshed) or any(
        not DOI.fullmatch(a["doi"]) or private_papers[k] != reviewed_article(a)
        for k, a in refreshed.items()
    ):
        raise ValueError(
            "Refreshed articles differ from the scientist's actual sources"
        )
    notes = bound_notes(work, science, articles)
    sources = keyed(notes["articles"], "paper")
    titles = keyed(notes["caseTitles"], "experiment")
    scientific = keyed(science["cases"], "experiment")
    selected = keyed(cases, "case")
    if (
        set(sources) != set(refreshed)
        or set(selected) != set(titles)
        or set(selected) != set(scientific)
    ):
        raise ValueError(
            "Literature notes do not cover the complete verified source selection"
        )
    private_cases = keyed(private["cases"], "experiment")
    names = {}
    bodies = {}
    for k, c in selected.items():
        b = c["binding"]
        e = app[b["experimentCode"]]
        if (
            e["sourceHash"] != scientific[k]["sourceHash"]
            or b["sourceHash"] != e["sourceHash"]
            or not SHA.fullmatch(e["sourceHash"])
        ):
            raise ValueError("Accepted experiment source digest differs")
        if c["sectionId"] != "case-" + k.lower() or not re.fullmatch(
            r"case-e[1-9]\d*", c["sectionId"]
        ):
            raise ValueError("Invalid local experiment section")
        if not isinstance(titles[k]["publishRecordedTitle"], bool):
            raise ValueError("Experiment title privacy decision missing")
        # If the private projection redacted anything, never reveal the original through the title.
        recorded_title = e["experiment"]["title"]
        if private_cases[k]["sourceHash"] != e["sourceHash"]:
            raise ValueError("Literature note addresses a different private case")
        names[k] = (
            recorded_title.strip()
            if titles[k]["publishRecordedTitle"]
            and private_cases[k]["title"] == recorded_title
            else ""
        )
    for lang in ("en", "zh"):
        zh = lang == "zh"
        chunks = [
            "<h3>"
            + ("实验与数据版本" if zh else "Experiments and accepted data")
            + "</h3><ul>"
        ]

        def link(k):
            c = selected[k]
            descriptive = wording(c["displayPublic"]["name"])[lang]
            label = c["binding"]["experimentCode"] + " · " + (names[k] or descriptive)
            if lang == "en" and names[k] and names[k] != descriptive:
                label += " — " + descriptive
            return '<a href="#' + c["sectionId"] + '">' + escape(label) + "</a>"

        for k, c in selected.items():
            h = c["binding"]["sourceHash"]
            # The full fingerprint stays selectable as one string on narrow displays.
            fingerprint = (
                '<code data-source-sha256="'
                + h
                + '">'
                + "<wbr>".join(h[i : i + 8] for i in range(0, len(h), 8))
                + "</code>"
            )
            chunks.append(
                "<li>"
                + link(k)
                + "<br>"
                + (
                    "已接受器件结果的 SHA-256 校验值"
                    if zh
                    else "Accepted device evidence · SHA-256"
                )
                + " "
                + fingerprint
                + "</li>"
            )
        chunks.append(
            "</ul><h3>"
            + (
                "原始研究及其适用范围"
                if zh
                else "Primary studies and where their findings apply"
            )
            + "</h3>"
        )
        for k, a in refreshed.items():
            n = sources[k]
            uses = keyed(n["uses"], "experiment")
            expected = {
                x for x, c in scientific.items() if k in c["chemical"]["sources"]
            }
            if set(uses) != expected:
                raise ValueError(
                    "Literature case attribution differs from signed scientific citations"
                )
            title = escape(a["title"])
            url = "https://doi.org/" + escape(a["doi"], quote=True)
            chunks.append(
                '<h4><a href="'
                + url
                + '">'
                + title
                + "</a></h4><p>"
                + escape(wording(n["finding"])[lang])
                + "</p><p>"
                + escape(wording(n["studyLimit"])[lang])
                + "</p>"
            )
            if not uses:
                chunks.append(
                    "<p>"
                    + (
                        "本周作为背景阅读，未用于任何重点实验的判断。"
                        if zh
                        else "Background reading this week. The detailed experiment reviews did not cite this study."
                    )
                    + "</p>"
                )
                continue
            chunks.append("<ul>")
            for case_key in selected:
                if case_key not in uses:
                    continue
                u = uses[case_key]
                chunks.append(
                    "<li>"
                    + link(case_key)
                    + "<p>"
                    + escape(wording(u["relevance"])[lang])
                    + "</p><p>"
                    + escape(wording(u["limit"])[lang])
                    + "</p></li>"
                )
            chunks.append("</ul>")
        bodies[lang] = "".join(chunks)
    return bodies, sources
