"""Make a *provider-safe* authoring packet from the deployed Pheno evidence export.

All private graph data, internal IDs, identifiers, recipe text, notes, registry
names and raw designs stay in the working directory. The source export remains
the authority on metric selection and arithmetic.
"""

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-science"))
from period_scope import scan_timing


def save(path, value):
    with tempfile.NamedTemporaryFile(
        dir=path.parent, delete=False, mode="w", encoding="utf-8"
    ) as file:
        json.dump(
            value, file, allow_nan=False, ensure_ascii=False, separators=(",", ":")
        )
        file.write("\n")
        temp = Path(file.name)
    os.replace(temp, path)


def read(path, expected_hash=None):
    raw = path.read_bytes()
    if expected_hash and hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError(
            "Prior snapshot or finalized ledger differs from selected baseline"
        )
    return json.loads(raw)


PERIODS = ("CURRENT_PERIOD", "PREVIOUS_EQUAL_DURATION_PERIOD", "EARLIER_HISTORY")
PAPERS = {
    "LINKER": ("10.1038/s41467-025-62388-4", "flexibility meets rigidity"),
    "BURIED_CONTACT": (
        "10.1038/s41467-025-68207-0",
        "anti-aggregation self-assembled monolayers",
    ),
    "LIGAND": (
        "10.1038/s41586-026-10626-0",
        "stereoelectronic manipulation of ligands",
    ),
}
TOPICS = {
    "anneal": ("退火", "anneal"),
    "carrier": ("溶剂", "载液", "solvent", "carrier"),
    "concentration": ("浓度", "concentration"),
    "coating": ("涂布", "涂覆", "刮涂", "coating", "blade"),
    "substrate": ("基底", "substrate"),
    "plasma": ("等离子", "plasma"),
    "material": ("材料", "material"),
}


def fetch_json(url):
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "PhenoLab-PublicLiterature/1.0",
        },
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                body = response.read(1_000_001)
            break
        except OSError as error:
            if attempt == 2 or getattr(error, "code", 0) in (400, 401, 403, 404):
                raise
            time.sleep(1 + attempt)
    if len(body) > 1_000_000:
        raise ValueError("Public metadata exceeds expected size")
    return json.loads(body)


def refresh_papers():
    # The three paths index primary authors' abstracts. Only fixed public DOIs
    # leave the host, never project titles, conditions or private material names.
    audits = []
    for alias, (doi, title_fragment) in PAPERS.items():
        query = urlencode(
            {"query": 'DOI:"' + doi + '"', "format": "json", "resultType": "core"}
        )
        urls = [
            "https://api.openalex.org/works/https://doi.org/" + doi,
            "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + query,
            "https://api.crossref.org/works/" + doi,
        ]
        match = None
        for index, url in enumerate(urls):
            try:
                data = fetch_json(url)
                if index == 0:
                    order = data.get("abstract_inverted_index") or {}
                    words = sorted(
                        (i, word)
                        for word, positions in order.items()
                        for i in positions
                    )
                    entries = [
                        (
                            data["doi"].removeprefix("https://doi.org/"),
                            data["title"],
                            " ".join(w for _, w in words),
                        )
                    ]
                elif index == 1:
                    entries = [
                        (
                            r.get("doi", ""),
                            r.get("title", ""),
                            r.get("abstractText", ""),
                        )
                        for r in data["resultList"]["result"]
                    ]
                else:
                    record = data["message"]
                    entries = [
                        (record["DOI"], record["title"][0], record.get("abstract", ""))
                    ]
                match = next(
                    (
                        (t, a)
                        for identifier, t, a in entries
                        if identifier.lower() == doi
                        and title_fragment in t.lower()
                        and a
                        and len(a) > 100
                    ),
                    None,
                )
            except (OSError, ValueError, KeyError, IndexError, TypeError):
                continue
            if match:
                break
        if not match:
            raise ValueError(
                "Public primary article identity or abstract unavailable: " + alias
            )
        title, abstract = match
        audits.append(
            {
                "paper": alias,
                "doi": doi,
                "title": title,
                "abstract": abstract,
                "sourceUrl": url,
                "refreshedAt": dt.datetime.now(dt.UTC).isoformat(),
            }
        )
    return audits


PUBLIC_SEARCHES = (
    (
        "perovskite solar cells self assembled monolayer buried interface",
        ("monolayer", "buried interface", "hole-selective"),
    ),
    (
        "perovskite solar cell passivation coating substrate device interface",
        ("passivation", "substrate", "coating", "surface treatment"),
    ),
)


def discover_articles(window_end, existing):
    # These search terms are static public concepts. Scope and request metadata
    # never include project names, internal molecules, employee names or recipes.
    end = dt.date.fromisoformat(window_end[:10])
    start = end - dt.timedelta(days=365)
    articles = []
    attempted = []
    known = {item["doi"].lower() for item in existing}
    for query, terms in PUBLIC_SEARCHES:
        params = {
            "search": query,
            "filter": f"from_publication_date:{start},to_publication_date:{end},type:article,has_abstract:true,is_retracted:false",
            "sort": "relevance_score:desc",
            "per_page": 4,
            "select": "id,doi,title,type,publication_date,is_retracted,is_paratext,abstract_inverted_index",
        }
        url = "https://api.openalex.org/works?" + urlencode(params)
        candidates = fetch_json(url)["results"]
        attempted.append({"query": query, "returned": len(candidates), "url": url})
        for item in candidates:
            raw_doi = item.get("doi") or ""
            doi = raw_doi.removeprefix("https://doi.org/").lower()
            work = str(item.get("id", "")).removeprefix("https://openalex.org/")
            title = item.get("title") or ""
            words = sorted(
                (position, word)
                for word, locations in (
                    item.get("abstract_inverted_index") or {}
                ).items()
                for position in locations
            )
            abstract = " ".join(word for _, word in words)
            subjects = (title + " " + abstract).lower()
            if (
                not re.fullmatch(r"W[0-9]{6,15}", work)
                or not re.fullmatch(r"10\.[0-9]{4,9}/\S+", doi)
                or not 5 <= len(title) <= 600
                or not 100 <= len(abstract) <= 12000
                or not raw_doi.startswith("https://doi.org/")
                or len({n for n, _ in words}) != len(words)
                or doi in known
                or "perovskite" not in subjects
                or not any(t in subjects for t in terms)
                or item.get("is_retracted") is not False
                or item.get("is_paratext") is not False
                or item.get("type") not in ("article", "journal-article")
                or re.search(
                    r"\b(review|perspective|outlook|roadmap|survey|correction)\b",
                    title,
                    re.IGNORECASE,
                )
                or not start.isoformat() <= item["publication_date"] <= end.isoformat()
            ):
                continue
            record = {
                "doi": raw_doi,
                "title": title,
                "date": item["publication_date"],
                "abstract": abstract,
            }
            hashed = hashlib.sha256(
                json.dumps(
                    record, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                ).encode()
            ).hexdigest()
            articles.append(
                {
                    "paper": "S" + str(len(articles) + 1),
                    "doi": doi,
                    "title": title,
                    "abstract": abstract,
                    "sourceUrl": "https://api.openalex.org/works/" + work,
                    "work": work,
                    "sourceHash": hashed,
                    "refreshedAt": dt.datetime.now(dt.UTC).isoformat(),
                }
            )
            known.add(doi)
            break
    return articles, attempted


def date(value):
    v = dt.datetime.fromisoformat(value)
    if not v.tzinfo:
        raise ValueError("Snapshot needs a timezone")
    return v.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def count(value):
    if type(value) is not int or value < 0:
        raise ValueError("Invalid source count")
    return value


def moments(values):
    result = {}
    for metric in ("pce", "voc", "jsc", "ff"):
        if values.get(metric) is None:
            continue
        stats = values[metric]
        row = {"n": count(stats["n"])}
        for key in ("mean", "best", "median", "sd", "iqr"):
            val = stats.get(key)
            if val is not None and (
                type(val) not in (float, int) or not math.isfinite(val)
            ):
                raise ValueError("Invalid device statistic")
            row[key] = val
        result[metric] = row
    return result


def actual_factors(evidence, labels):
    factors = []
    for c in evidence["conditions"]:
        name = c["parameterName"].lower()
        kind = next(
            (k for k, terms in TOPICS.items() if any(t in name for t in terms)), "other"
        )
        for g, v in c["actualByGroup"].items():
            if g not in labels:
                continue
            status = v["status"]
            factors.append(
                {
                    "kind": kind,
                    "group": labels[g],
                    "status": status
                    if status
                    in ("RECORDED_MATCH", "DEVIATION", "RETROSPECTIVE", "NOT_RECORDED")
                    else "OTHER",
                    "plannedDevices": count(v["nPlannedSamples"]),
                    "recordedDevices": count(v["nRecordedSamples"]),
                }
            )
    return factors


def cases_for_detail(rows, followup_order=()):
    # Coverage is explicit: all exported experiments are in the inventory.
    # Give each project a turn before taking a second case from the same project.
    priority = {case: index for index, case in enumerate(followup_order)}
    selected = [r["id"] for r in sorted(rows, key=lambda r: priority.get(r["id"], len(priority)))
                if r["id"] in priority and r["eligible"]]
    remaining = [r for r in rows if r["eligible"] and r["id"] not in priority]
    eligible = sorted(remaining, key=lambda r: (-r["freshMeasuredSources"], -r["newlyMeasuredSources"], r["id"]))
    for fresh in (True, False):
        waiting = [r for r in eligible if (r["freshMeasuredSources"] > 0) == fresh]
        while waiting and len(selected) < 3:
            seen, deferred = set(), []
            for row in waiting:
                if row["project"] in seen:
                    deferred.append(row)
                    continue
                seen.add(row["project"])
                selected.append(row["id"])
                if len(selected) == 3:
                    break
            waiting = deferred
    return selected[:3]


def snapshot_sources(snapshot):
    result = {}
    for row in (
        snapshot["historicalSampleMeasurements"] + snapshot["sampleMeasurements"]
    ):
        alias = row.get("measurementAlias")
        if alias and row["sourceLinked"]:
            if (
                alias in result
                and result[alias]["experimentCode"] != row["experimentCode"]
            ):
                raise ValueError("Measurement alias maps to conflicting experiments")
            result[alias] = row
    return result


def projection(snapshot, dossier, prior, previous_dossier, articles):
    export = snapshot["sharedAppEvidence"]
    if (
        snapshot["truncated"]
        or not snapshot["readOnly"]
        or export["methodVersion"] != "pheno-device-evidence-2026-10-28"
    ):
        raise ValueError("Full read-only evidence export required")
    if (
        export["selectionScope"] != "EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT"
        or not export["readOnly"]
    ):
        raise ValueError("Unexpected source population")
    if date(dossier["snapshotAt"]) != date(snapshot["snapshotAt"]) or date(
        export["sourceSnapshotAt"]
    ) != date(snapshot["snapshotAt"]):
        raise ValueError("Inconsistent snapshot cutoff")
    primary = dossier["primaryExperimentEvidence"]
    if (
        primary["experiments"] != export["experiments"]
        or primary["asOf"] != export["asOf"]
    ):
        raise ValueError("App evidence does not match dossier export")
    pmap, emap, projects, details, rows, bindings = (
        {},
        {},
        [],
        [],
        [],
        {"cases": {}, "projects": {}},
    )
    for n, p in enumerate(dossier["projects"], 1):
        project = "P" + str(n)
        if p["projectAlias"] in pmap:
            raise ValueError("Ambiguous project relations")
        pmap[p["projectAlias"]] = project
        bindings["projects"][project] = {
            "projectAlias": p["projectAlias"],
            "name": p["projectName"],
        }
        for e in p["experiments"]:
            if e["experimentCode"] in emap:
                raise ValueError("Experiment assigned to multiple projects")
            emap[e["experimentCode"]] = project
        panels = collections.Counter(
            route["periodCohort"]
            for route in p["periodPerformance"]["routeCohorts"]
            if route["view"] == "STRICT_RECORDED_PROTOCOL"
        )
        prior_entries = [
            l
            for l in previous_dossier["ledgerEntries"]
            if l.get("projectAlias") == p["projectAlias"]
        ]
        states = [
            l["status"]
            if l["status"]
            in (
                "proposed",
                "not-evaluated",
                "supported",
                "weakened",
                "inconclusive",
                "completed",
            )
            else "other"
            for l in prior_entries
        ]
        projects.append(
            {
                "id": project,
                "assigned": p["assigned"],
                "measuredScans": count(p["newMeasuredEvidenceScans"]),
                "priorUnseenSources": count(p["newSourceAliasesSincePriorSnapshots"]),
                "olderReceipts": count(p["receivedOlderMeasurementsDuringPeriod"]),
                "ledgerStates": states,
                "routePanelCounts": [
                    {"period": period, "count": panels[period]} for period in PERIODS
                ],
            }
        )
    fresh, _, _ = scan_timing(snapshot, prior)
    prior_ids = snapshot_sources(prior)
    measurements = collections.defaultdict(list)
    for alias, src in snapshot_sources(snapshot).items():
        measurements[src["experimentCode"]].append((alias, src))
    prev_hashes = {
        e["experimentCode"]: e["evidence"]["sourceHash"]
        for e in prior.get("sharedAppEvidence", {}).get("experiments", [])
    }
    entries = export["experiments"]
    if len({e["experimentCode"] for e in entries}) != len(entries):
        raise ValueError("Ambiguous experiment identifiers")
    for i, entry in enumerate(entries, 1):
        code, e = entry["experimentCode"], entry["evidence"]
        if (
            e["experiment"]["code"] != code
            or e["policyVersion"] != "accepted-device-result-v1"
        ):
            raise ValueError("Primary policy/experiment mismatch")
        if code not in emap:
            raise ValueError("Missing explicit project or unassigned relation")
        sources = measurements[code]
        eligible = any(
            any(
                (g.get("metrics", {}).get("pce") or {}).get("n", 0) > 0
                for g in c["groups"]
            )
            for c in e["characterizations"]
        )
        rows.append(
            {
                "id": "E" + str(i),
                "project": emap[code],
                "focus": e["evaluationFocus"]["kind"],
                "freshMeasuredSources": fresh.get(code, 0),
                "newlyMeasuredSources": sum(
                    bool(s["measuredInPeriod"]) for _, s in sources
                ),
                "earlierReceipts": sum(
                    bool(
                        s["receivedInPeriod"]
                        and s["measuredAt"]
                        and date(s["measuredAt"]) < date(snapshot["periodStart"])
                    )
                    for _, s in sources
                ),
                "newSourceAliases": sum(alias not in prior_ids for alias, _ in sources),
                "eligible": eligible,
            }
        )
    scope = snapshot.get("weeklyCollectionScope", {})
    aliases = {entry["experimentCode"]: row["id"] for entry, row in zip(entries, rows)}
    followups = [aliases[item["experimentCode"]] for item in scope.get("followups", [])]
    select = cases_for_detail(rows, followups)
    if scope.get("mode") == "CARRIED_FORWARD" and not select:
        raise ValueError("No prior or current case has accepted device results available for a reviewed follow-up.")
    for entry, row in zip(entries, rows):
        code, e = entry["experimentCode"], entry["evidence"]
        selected = row["id"] in select
        eligible = row.pop("eligible")
        row.update(
            selected=selected,
            reason="detailed-comparison"
            if selected
            else "covered-in-inventory"
            if eligible
            else "no-accepted-characterization",
        )
        labels = {}
        for ch in e["characterizations"]:
            for g in ch["groups"]:
                labels.setdefault(g["label"], "G" + str(len(labels) + 1))
        charmap = {
            "T" + str(i): c["id"] for i, c in enumerate(e["characterizations"], 1)
        }
        bindings["cases"][row["id"]] = {
            "code": code,
            "sourceHash": e["sourceHash"],
            "label": e["experiment"]["title"],
            "scope": row["reason"],
            "groups": {v: k for k, v in labels.items()},
            "characterizations": charmap,
        }
        if not selected:
            continue
        chars = [
            {
                "id": "T" + str(i),
                "groups": [
                    {
                        "id": labels[g["label"]],
                        "stats": moments(g["metrics"]),
                        "judgment": g["judgment"],
                    }
                    for g in ch["groups"]
                ],
            }
            for i, ch in enumerate(e["characterizations"], 1)
        ]
        ex = e["experiment"]
        details.append(
            {
                "id": row["id"],
                "project": row["project"],
                "focus": row["focus"],
                "hasRecordedBackground": bool(ex.get("observation")),
                "hasRecordedQuestion": bool(ex.get("problem")),
                "hasRecordedHypothesis": bool(ex.get("hypothesis")),
                "hasRecordedConclusion": bool(ex.get("conclusion")),
                "acceptedSourceChanged": (prev_hashes[code] != e["sourceHash"])
                if code in prev_hashes
                else None,
                "groups": [{"id": q} for q in labels.values()],
                "selectedReference": labels.get(e["reference"].get("selectedGroup")),
                "declaredControl": labels.get(e["reference"].get("declaredGroup")),
                "factors": actual_factors(e, labels),
                "characterizations": chars,
            }
        )
    packet = {
        "schemaVersion": 1,
        "period": {
            "start": date(snapshot["periodStart"]),
            "end": date(snapshot["windowEnd"]),
            "acceptedAsOf": date(export["asOf"]),
            **({"carriedForward": scope["mode"] == "CARRIED_FORWARD"} if scope else {}),
        },
        "method": export["methodVersion"],
        "projects": projects,
        "inventory": rows,
        "cases": details,
        "papers": [p["paper"] for p in articles],
        "literatureUpdates": [
            {"id": p["paper"], "work": p["work"], "sourceHash": p["sourceHash"]}
            for p in articles
            if "work" in p
        ],
    }
    return packet, bindings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--prior-snapshot", type=Path)
    parser.add_argument("--prior-dossier", type=Path)
    args = parser.parse_args()
    root = args.run.resolve()
    baseline = read(root / "baseline-selection.json")
    if baseline["status"] != "PUBLISHED_VERIFIED":
        raise ValueError("Verified published baseline required")
    prior = read(
        args.prior_snapshot or Path(baseline["snapshot"]), baseline["snapshotSha256"]
    )
    previous_dossier = read(
        args.prior_dossier or Path(baseline["dossierPublished"]),
        baseline["dossierPublishedSha256"],
    )
    snapshot = read(root / "snapshot.json")
    dossier = read(root / "rd-dossier.json")
    articles = refresh_papers()
    discoveries, queries = discover_articles(snapshot["windowEnd"], articles)
    articles += discoveries
    packet, bindings = projection(snapshot, dossier, prior, previous_dossier, articles)
    save(root / "article-refresh.json", articles)
    save(root / "article-search-audit.json", queries)
    save(root / "bindings.private.json", bindings)
    save(root / "provider-packet.json", packet)
    print(
        f"Prepared {len(packet['cases'])} detailed cases across {len(packet['inventory'])} exported experiments."
    )


if __name__ == "__main__":
    main()
