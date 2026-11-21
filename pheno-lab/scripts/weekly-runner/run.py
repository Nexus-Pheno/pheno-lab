"""Server entry point. A frozen historical replay has no path to publication."""

from __future__ import annotations
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
from zoneinfo import ZoneInfo

APP = Path(__file__).resolve().parents[2]
SCI = APP / "scripts/weekly-science"
AUTHOR = APP / "scripts/weekly-manuscript"
RUNNER = Path(__file__).resolve().parent
CHINA = ZoneInfo("Asia/Shanghai")
UTC = dt.timezone.utc


def due(now):
    here = now.astimezone(CHINA)
    since = (here.weekday() - 5) % 7
    slot = (here - dt.timedelta(days=since)).replace(
        hour=9, minute=0, second=0, microsecond=0
    )
    return slot if slot <= here else slot - dt.timedelta(days=7)


def write(path, value):
    data = (
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode()
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Frozen file differs from this operation.")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
    try:
        os.link(tmp.name, path)
    finally:
        os.unlink(tmp.name)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path):
    return json.loads(path.read_bytes())


def run(*cmd, stdout=subprocess.DEVNULL, stdin=None, timeout=3600):
    return subprocess.run(
        [str(v) for v in cmd],
        cwd=APP,
        check=True,
        stdin=stdin,
        stdout=stdout,
        timeout=timeout,
    )


def ts(*args, **opts):
    return run(APP / "node_modules/.bin/tsx", *args, **opts)


def inspect(state, key):
    return json.loads(
        ts(
            RUNNER / "inspect.ts", state / "roster.json", key, stdout=subprocess.PIPE
        ).stdout
    )


def key_for(slot):
    return "materials-process-weekly-" + slot.date().isoformat() + "-v1"


def validate_receipt(receipt, envelope):
    body = envelope["html"].encode()
    if (
        receipt["status"] != "PUBLISHED"
        or receipt["publicationKey"] != envelope["publicationKey"]
    ):
        raise ValueError("Publication missing for the frozen week.")
    fields = ["organizationId", "titleEn", "titleZh", "generatedAt"]
    if any(receipt[k] != envelope[k] for k in fields) or sorted(
        receipt["recipientIds"]
    ) != sorted(envelope["recipientIds"]):
        raise ValueError("Production metadata differs from the frozen publication.")
    if (
        receipt["contentBytes"] != len(body)
        or receipt["contentSha256"] != hashlib.sha256(body).hexdigest()
    ):
        raise ValueError("Production content differs from the frozen report.")


def finish(state, work, receipt):
    envelope = read(work / "publication-envelope.json")
    validate_receipt(receipt, envelope)
    write(work / "publication-verification.json", receipt)
    dossier = read(work / "rd-dossier-reviewed.json")
    selected = read(work / "baseline-selection.json")
    earlier = read(Path(selected["dossierPublished"]))
    old = {r["entryId"]: r for r in earlier["ledgerEntries"]}
    for row in dossier["ledgerEntries"]:
        if row["entryId"] in old:
            previous = old.pop(row["entryId"])
            if (
                row != previous
                and row["history"][: len(previous["history"])] != previous["history"]
            ):
                raise ValueError("Prior research history differs.")
        elif row["status"] == "proposed":
            for container in (row, row["history"][-1]):
                if receipt["reportId"] not in container["sourceReportIds"]:
                    container["sourceReportIds"].append(receipt["reportId"])
    if old:
        raise ValueError("Prior research entries are missing.")
    snapshot = work / "snapshot.json"

    def digest(file):
        with file.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    source_hash = digest(snapshot)
    url = "https://lab.szkl.com/reports/" + receipt["reportId"]
    dossier["publicationBaseline"] = dict(
        reportId=receipt["reportId"],
        reportUrl=url,
        publicationKey=receipt["publicationKey"],
        publicationVerified=True,
        publishedAt=receipt["publishedAt"],
        sourceHash=source_hash,
    )
    published = work / "rd-dossier-published.json"
    write(published, dossier)
    write(
        work / "run-result.json",
        dict(
            schemaVersion=2,
            publicationVerified=True,
            reportId=receipt["reportId"],
            reportUrl=url,
            publicationKey=receipt["publicationKey"],
            contentSha256=receipt["contentSha256"],
            contentBytes=receipt["contentBytes"],
            publishedAt=receipt["publishedAt"],
            snapshot=str(snapshot),
            snapshotSha256=source_hash,
            snapshotAt=dossier["snapshotAt"],
            dossierPublished=str(published),
            dossierPublishedSha256=digest(published),
            ledgerEntries=len(dossier["ledgerEntries"]),
            priorReportId=selected["reportId"],
            recipientCount=5,
            notificationCount=5,
            publishAuditCount=1,
            requireExistingAccess=True,
        ),
    )
    ts(RUNNER / "archive.ts", "save", work, work / "publication-verification.json")
    run(
        sys.executable,
        "-B",
        SCI / "import_verified_baseline.py",
        "--source",
        work,
        "--root",
        state / "baselines",
    )


def verify_delivery_files(work):
    gate = work / "gate"
    ready = read(gate / "ready.json")
    challenge = read(gate / "challenge.json")
    review_names = {"scientific-review.json", "visual-review.json"}
    if (
        ready.get("status") != "READY_FOR_AUTHORIZED_PUBLICATION"
        or ready.get("passed") is not True
        or ready.get("publicationPerformed") is not False
        or ready["contentSha256"] != challenge["contentSha256"]
        or ready["verifiedArtifactHashes"] != challenge["inputs"]
        or set(ready["reviewHashes"]) != review_names
    ):
        raise ValueError("Final review does not match the frozen report.")
    files = [(work / k, v) for k, v in ready["verifiedArtifactHashes"].items()]
    files += [(work / "reviews" / k, v) for k, v in ready["reviewHashes"].items()]
    files += [
        (gate / "challenge.json", ready["challengeSha256"]),
        (gate / "report-document-reviewed.json", ready["signedDocumentSha256"]),
        (gate / "approved/gates.json", ready["finalGatesSha256"]),
    ]
    for path, expected in files:
        if path.is_symlink() or not path.resolve().is_relative_to(work.resolve()):
            raise ValueError("Invalid reviewed artifact path.")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise ValueError("A reviewed report input changed before delivery.")
    return ready


def deliver(state, work):
    manifest = verify_delivery_files(work)
    html = (work / "report-publish.html").read_bytes()
    if (
        manifest["passed"] is not True
        or manifest["contentSha256"] != hashlib.sha256(html).hexdigest()
    ):
        raise ValueError("Independent final review does not match HTML.")
    meta = read(work / "report-publish.metadata.json")
    document = read(work / "report-document-publish.json")
    if any(
        meta.get(k) != document.get(k) for k in ("titleEn", "titleZh", "generatedAt")
    ):
        raise ValueError(
            "Stored report title or date differs from reviewed manuscript."
        )
    key = work.name
    fresh = inspect(state, key)
    generated = dt.datetime.fromisoformat(
        meta["generatedAt"].replace("Z", "+00:00")
    ).astimezone(UTC)
    envelope = dict(
        organizationId=fresh["organizationId"],
        publicationKey=key,
        titleEn=meta["titleEn"],
        titleZh=meta["titleZh"],
        generatedAt=generated.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        html=html.decode(),
        recipientIds=sorted(fresh["recipientIds"]),
        requireExistingAccess=True,
        authorizationReference="Approved recurring Saturday server publication",
    )
    frozen = work / "publication-envelope.json"
    write(frozen, envelope)
    if fresh["status"] == "ABSENT":
        with frozen.open("rb") as file:
            ts(APP / "scripts/publish-lab-report.ts", stdin=file)
    finish(state, work, inspect(state, key))


@contextmanager
def staged_output(path):
    """Only a complete, synced file becomes a resumable source checkpoint."""
    with tempfile.TemporaryDirectory(prefix=".pending-", dir=path.parent) as scratch:
        staged = Path(scratch) / path.name
        yield staged
        if staged.is_symlink() or not staged.is_file():
            raise ValueError("Missing completed source file.")
        with staged.open("rb") as file:
            os.fsync(file.fileno())
        os.link(staged, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def recover_prior_publications(state, current_key):
    for envelope in sorted(
        (state / "work").glob("materials-process-weekly-*/publication-envelope.json")
    ):
        earlier = envelope.parent
        if (
            earlier.name >= current_key
            or (state / "baselines" / earlier.name / "run-result.json").is_file()
        ):
            continue
        receipt = inspect(state, earlier.name)
        if receipt["status"] != "PUBLISHED":
            raise ValueError(
                "An earlier frozen delivery must be reconciled before a new week can start."
            )
        finish(state, earlier, receipt)


def collect(state, work, slot):
    roster = read(state / "roster.json")
    reader = (state / "evidence-reader").read_text().strip()
    flags = [
        item
        for user in roster["recipients"]
        for item in ("--recipient-email", user["email"])
    ]

    def stamp(days):
        return (slot - dt.timedelta(days=days)).astimezone(UTC).isoformat()

    if not (work / "baseline-selection.json").exists():
        with staged_output(work / "baseline-selection.json") as staged:
            run(
                sys.executable,
                "-B",
                SCI / "select_published_baseline.py",
                "--root",
                state / "baselines",
                "--output",
                staged,
            )
    with staged_output(work / "snapshot.json") as staged:
        run(
            sys.executable,
            "-B",
            SCI / "collect_snapshot.py",
            "--local-operator",
            "--with-app-evidence",
            "--baseline-selection",
            work / "baseline-selection.json",
            "--start",
            stamp(30),
            "--end",
            stamp(0),
            "--period-start",
            stamp(7),
            "--history-start",
            stamp(90),
            "--evidence-reader-email",
            reader,
            *flags,
            "--output",
            staged,
        )


def prepare_dossier(work, prior):
    if not (work / "rd-dossier.json").exists():
        with staged_output(work / "rd-dossier.json") as staged:
            run(
                sys.executable,
                "-B",
                SCI / "analyze_rd_snapshot.py",
                work / "snapshot.json",
                staged,
                "--previous-snapshot",
                prior / "snapshot.json",
                "--prior-ledger",
                prior / "rd-dossier-published.json",
            )
    run(
        sys.executable,
        "-B",
        AUTHOR / "prepare.py",
        work,
        "--prior-snapshot",
        prior / "snapshot.json",
        "--prior-dossier",
        prior / "rd-dossier-published.json",
    )
    ts(AUTHOR / "write.ts", work)


def rehearse(state, archive, predecessor, attempt):
    """Use the scheduled analysis on a published snapshot, without a delivery path."""
    archive = archive.resolve(strict=True)
    predecessor = predecessor.resolve(strict=True)
    sys.path.insert(0, str(SCI))
    from replay_frozen_report import check_published_run

    original, previous = check_published_run(archive), check_published_run(predecessor)
    key = original["publicationKey"]
    if not key.startswith("materials-process-weekly-") or Path(key).name != key:
        raise ValueError("Rehearsal needs an immutable weekly period.")
    initial_manifest = archive / "original-run-result.json"
    lineage = read(initial_manifest) if initial_manifest.exists() else original
    if lineage["priorReportId"] != previous["reportId"]:
        raise ValueError(
            "The rehearsal predecessor is not the published report's original baseline."
        )
    before = inspect(state, key)
    if (
        before["status"] != "PUBLISHED"
        or before["reportId"] != original["reportId"]
        or before["contentSha256"] != original["contentSha256"]
    ):
        raise ValueError("Original report is not reconciled.")
    private = (state / "acceptance").resolve(strict=True)
    target = attempt or private / ("reanalysis-" + key)
    if target.is_symlink() or target.resolve().parent != private:
        raise ValueError("Rehearsal requires a dedicated private acceptance directory.")
    target = target.resolve()
    target.mkdir(mode=0o700, exist_ok=True)
    if (
        target.stat().st_uid != os.geteuid()
        or target.stat().st_mode & 0o077
        or (target / "publication-envelope.json").exists()
    ):
        raise ValueError("Private unpublished rehearsal required.")
    write(target / "rehearsal-original.json", before)
    try:
        snapshot = target / "snapshot.json"
        if not snapshot.exists():
            with (
                staged_output(snapshot) as staged,
                (archive / "snapshot.json").open("rb") as source,
                staged.open("xb") as frozen,
            ):
                shutil.copyfileobj(source, frozen)
                frozen.flush()
                os.fsync(frozen.fileno())
        with snapshot.open("rb") as frozen:
            if (
                hashlib.file_digest(frozen, "sha256").hexdigest()
                != original["snapshotSha256"]
            ):
                raise ValueError("Rehearsal snapshot differs from the original.")
        selection = target / "baseline-selection.json"
        if not selection.exists():
            write(
                selection,
                dict(
                    **previous,
                    status="PUBLISHED_VERIFIED",
                    sourceRunResult=str(predecessor / "run-result.json"),
                ),
            )
        bound = read(selection)
        if any(
            bound[k] != previous[k]
            for k in ("reportId", "snapshotSha256", "dossierPublishedSha256")
        ):
            raise ValueError("Rehearsal baseline changed.")
        if not (target / "provider-packet.json").exists():
            prepare_dossier(target, predecessor)
        elif not (target / "manuscript-candidate.json").exists():
            ts(AUTHOR / "write.ts", target)
        run(
            sys.executable,
            "-B",
            RUNNER / "review_work.py",
            target,
            predecessor,
            timeout=18000,
        )
        review = verify_delivery_files(target)
    finally:
        after = inspect(state, key)
        if after != before:
            raise ValueError(
                "Original report or existing delivery changed during rehearsal."
            )
    write(
        target / "rehearsal-result.json",
        dict(
            originalContentSha256=before["contentSha256"],
            reviewedCandidateSha256=review["contentSha256"],
            sourceSha256=original["snapshotSha256"],
            reportId=before["reportId"],
            publicationKey=key,
            noticeCount=len(after["noticeIds"]),
            originalDeliveryPreserved=True,
            publicationPerformed=False,
        ),
    )
    print("Reanalysis passed. The original report, audit and five notices are intact.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("scheduled", "replay", "rehearse"))
    parser.add_argument("--state", default="/var/lib/pheno-lab-weekly", type=Path)
    parser.add_argument("--frozen", type=Path)
    parser.add_argument("--prior", type=Path)
    parser.add_argument(
        "--attempt", type=Path, help="Resume a private non-publishing rehearsal."
    )
    args = parser.parse_args()
    os.umask(0o077)
    state = args.state.resolve(strict=True)
    if state.stat().st_mode & 0o077 or state.stat().st_uid != os.geteuid():
        raise ValueError("Private reporting state required.")
    with (state / "job.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == "rehearse":
            if not args.frozen or not args.prior:
                parser.error(
                    "Rehearsal requires a published period and its original predecessor."
                )
            rehearse(state, args.frozen, args.prior, args.attempt)
            return
        if args.attempt:
            parser.error("A private acceptance directory is only used for rehearsal.")
        if args.mode == "replay":
            if not args.frozen or not args.prior:
                parser.error("Replay requires two verified dated baselines.")
            key = read(args.frozen / "run-result.json")["publicationKey"]
            before = inspect(state, key)
            if before["status"] != "PUBLISHED":
                raise ValueError("Historical replay requires an existing report.")
            work = Path(tempfile.mkdtemp(prefix="proof-", dir=state / "acceptance"))
            run(
                sys.executable,
                "-B",
                SCI / "replay_frozen_report.py",
                "--run",
                args.frozen,
                "--prior",
                args.prior,
                "--output",
                work / "historical",
            )
            if inspect(state, key) != before:
                raise ValueError(
                    "Publication, audit, or notices changed during replay."
                )
            print("Verified historical replay. Original delivery is intact.")
            return
        slot = due(dt.datetime.now(UTC))
        key = key_for(slot)
        first = inspect(state, key)
        work = state / "work" / key
        if first["status"] == "PUBLISHED":
            if (work / "publication-envelope.json").exists():
                finish(state, work, first)
            else:
                manifest = read(state / "baselines" / key / "run-result.json")
                if (
                    manifest["reportId"] != first["reportId"]
                    or manifest["contentSha256"] != first["contentSha256"]
                ):
                    raise ValueError(
                        "Published week requires verified archive recovery."
                    )
            print("Verified existing publication and five notices.")
            return
        recover_prior_publications(state, key)
        work.mkdir(mode=0o700, parents=True, exist_ok=True)
        if (work / "publication-envelope.json").exists():
            deliver(state, work)
            return
        if not (work / "snapshot.json").is_file():
            collect(state, work, slot)
        baseline = read(work / "baseline-selection.json")
        prior = Path(baseline["snapshot"]).parent
        if not (work / "provider-packet.json").exists():
            prepare_dossier(work, prior)
        elif not (work / "manuscript-candidate.json").is_file():
            ts(AUTHOR / "write.ts", work)
        # The same final gate, independently reviewed paper and frozen-envelope path
        # are used on first publication and after an uncertain response.
        run(sys.executable, "-B", RUNNER / "review_work.py", work, prior, timeout=18000)
        deliver(state, work)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as err:
        print(
            "Weekly report stopped. Review the private attempt and reconcile delivery before retrying. "
            + type(err).__name__,
            file=sys.stderr,
        )
        sys.exit(1)
