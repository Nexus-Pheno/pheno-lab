"""Generate one fresh paper, require independent scientific and visual review, and keep the reviewed bytes."""

from __future__ import annotations
import hashlib
from pathlib import Path
import subprocess
import sys

from run import APP, SCI, AUTHOR, RUNNER, read, write, run, ts
from envelopes import assemble

sys.path.insert(0, str(SCI))
import analyze_rd_snapshot


def reviewed_ledger(work, prior):
    source = read(work / "rd-dossier.json")
    base = read(prior / "rd-dossier-published.json")
    if source["ledgerEntries"] != base["ledgerEntries"] and sorted(
        source["ledgerEntries"], key=lambda e: e["entryId"]
    ) != sorted(base["ledgerEntries"], key=lambda e: e["entryId"]):
        raise ValueError(
            "Unreviewed source ledger differs from the verified predecessor."
        )
    old = {v["entryId"]: v for v in base["ledgerEntries"]}
    index = read(work / "science-public-index.private.json")
    bound = read(work / "bindings.private.json")["cases"]
    science_receipt = read(work / "independent-material-science-review.json")
    if (
        science_receipt["value"]["decision"] != "PASS"
        or not science_receipt["completionId"]
    ):
        raise ValueError("Missing independent scientific review.")
    by_code = {
        v["code"]: v for v in read(work / "snapshot.json")["experimentSummaries"]
    }
    changes = {}
    for row in index["cases"]:
        code = row["binding"]["experimentCode"]
        body = row["public"]["nextStep"]["en"]
        project = by_code[code]["projectAlias"] or "UNASSIGNED"
        ident = (
            "weekly-next-"
            + hashlib.sha256((code + "\n" + body).encode()).hexdigest()[:24]
        )
        if ident in old or any(v["statement"] == body for v in old.values()):
            continue
        changes[ident] = dict(
            entryId=ident,
            type="recommendation",
            expectedRevision=0,
            projectAlias=project,
            statement=body,
            owner=None,
            status="proposed",
            sourceReportIds=[],
            evidenceIdentifiers=[code],
            reviewedBy="Independent scientific reviewer "
            + science_receipt["completionId"],
            reviewedAt=science_receipt["reviewedAt"],
            decisionNote="Proposed controlled test. Execution has not been recorded.",
        )
    for item in index.get("followupAssessments", []):
        if item["assessment"] == "no-new-direct-test":
            continue
        ident = item["entryId"]
        entry = old[ident]
        if ident in changes:
            continue
        code = bound[item["experiment"]]["code"]
        changes[ident] = dict(
            entryId=ident,
            expectedRevision=entry["revision"],
            status=entry["status"],
            sourceReportIds=entry["sourceReportIds"],
            evidenceIdentifiers=list(
                dict.fromkeys(entry["evidenceIdentifiers"] + [code])
            ),
            reviewedAt=science_receipt["reviewedAt"],
            reviewedBy="Independent scientific reviewer "
            + science_receipt["completionId"],
            decisionNote=item["rationale"]["en"],
        )
    decisions = read(work / "project-decisions.json")
    reviews = read(work / "project-decisions-review.json")
    for row, receipt in zip(decisions["projects"], reviews["projects"], strict=True):
        lookup = {v["key"]: v["entryId"] for v in receipt["issueBindings"]}
        by_experiment = {v["experimentCode"]: v for v in row["routeIntents"]}
        for follow in row["issueAssessments"]:
            ident = lookup[follow["key"]]
            if ident in changes or follow["assessment"] == "no-new-direct-test":
                continue
            codes = follow["testedExperimentCodes"]
            if not codes or not all(c in by_experiment for c in codes):
                raise ValueError("Prior issue lacks a verifiable experiment.")
            entry = old[ident]
            changes[ident] = dict(
                entryId=ident,
                expectedRevision=entry["revision"],
                status=entry["status"],
                sourceReportIds=entry["sourceReportIds"],
                evidenceIdentifiers=list(
                    dict.fromkeys(entry["evidenceIdentifiers"] + codes)
                ),
                reviewedAt=science_receipt["reviewedAt"],
                reviewedBy="Independent project review " + row["project"],
                decisionNote=follow["rationale"]["en"],
            )
    updates = list(changes.values())
    source["ledgerEntries"] = analyze_rd_snapshot.update_ledger([base], updates)
    write(work / "reviewed-updates.json", updates)
    write(work / "rd-dossier-reviewed.json", source)


def workflow(work, prior):
    if not (work / "project-decisions-review.json").exists():
        ts(APP / "scripts/weekly-report-model-projects.ts", work, timeout=14400)
    if not (work / "private-chemistry-descriptors.json").exists():
        run(
            "node",
            SCI / "describe_private_chemistry.mjs",
            work / "snapshot.json",
            work / "private-chemistry-descriptors.json",
        )
    if not (work / "private-scientific-facts.json").exists():
        run(sys.executable, "-B", AUTHOR / "private_science.py", work)
    if not (work / "independent-material-science-review.json").exists():
        ts(AUTHOR / "science.ts", work, timeout=10800)
    if not (work / "science-public-index.private.json").exists():
        run(sys.executable, "-B", AUTHOR / "assemble_science.py", work)
    reviewed_ledger(work, prior)
    if not (work / "report-document-publish.json").exists():
        write(work / "report-document-publish.json", assemble(work, prior))
    if not (work / "report-publish.html").exists():
        run(
            sys.executable,
            "-B",
            SCI / "render_report.py",
            work / "report-document-publish.json",
            work / "report-publish.html",
        )
    gate = work / "gate"
    reviews = work / "reviews"
    reviews.mkdir(mode=0o700, exist_ok=True)
    if not (gate / "challenge.json").exists():
        run(
            sys.executable,
            "-B",
            SCI / "check_ready.py",
            "prepare",
            "--run",
            work,
            "--prior",
            prior,
            "--output",
            gate,
        )
    if not (reviews / "scientific-review.json").exists():
        ts(SCI / "science-review.ts", gate, reviews)
    if not (reviews / "visual-review.json").exists():
        ts(RUNNER / "vision.ts", gate, reviews, timeout=10800)
    if not (gate / "ready.json").exists():
        run(
            sys.executable,
            "-B",
            SCI / "check_ready.py",
            "verify",
            "--run",
            work,
            "--prior",
            prior,
            "--output",
            gate,
            "--reviews",
            reviews,
        )
    if not (gate / "ready.json").exists():
        raise ValueError("Complete independent approval is required.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Expected run directory and verified prior directory.")
    workflow(
        Path(sys.argv[1]).resolve(strict=True), Path(sys.argv[2]).resolve(strict=True)
    )
