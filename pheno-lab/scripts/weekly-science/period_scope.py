"""Select and audit the weekly report's device-evidence collection against a verified predecessor."""
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

import analyze_rd_snapshot as analysis
import audit_device_results as audit
import shared_app_evidence as shared


def _has_devices(evidence):
    # Presence only. Statistics and selection remain owned by the application.
    return any((group.get("metrics", {}).get("pce") or {}).get("n", 0) > 0
               for characterization in evidence["characterizations"]
               for group in characterization["groups"])


def derive(snapshot, prior, dossier, metadata):
    start, end = (shared.timestamp(snapshot[key]) for key in ("periodStart", "windowEnd"))
    if shared.timestamp(prior["windowEnd"]) >= end:
        raise ValueError("Weekly scope needs an earlier verified period")
    contexts = {item["code"]: item for item in snapshot["experimentSummaries"]}
    current_codes = shared.selected_experiment_codes(snapshot)
    previous_scans = audit.raw_scans(prior)
    current_scans = audit.raw_scans(snapshot)
    measured, latest = set(), {}
    for alias, row in current_scans.items():
        code = row.get("experimentCode")
        value = row.get("measuredAt")
        if not value or code not in contexts or row.get("sourceLinked") is not True:
            continue
        measured_at = shared.timestamp(value)
        diagnostics = analysis.metric_diagnostics({**row, "metricUnits": row.get("metricUnits") or snapshot.get("metricUnits")})
        if not diagnostics["performanceInferenceEligible"]:
            continue
        if measured_at < end:
            latest[code] = max(latest.get(code, measured_at), measured_at)
        if alias not in previous_scans and start <= measured_at < end:
            measured.add(alias)

    scope = {
        "schemaVersion": 1, "policy": "weekly-current-and-prior-followup-v1",
        "mode": "NEW_MEASUREMENTS" if measured else "CARRIED_FORWARD",
        "newEligibleMeasuredAliases": len(measured), "currentContextCodes": current_codes,
        "previousReportId": metadata["reportId"], "previousSnapshotSha256": metadata["snapshotSha256"],
        "previousDossierSha256": metadata["dossierPublishedSha256"], "previousWindowEnd": prior["windowEnd"],
        "followups": [], "requestedExperimentCodes": current_codes,
    }
    if measured:
        return scope

    # Only use real named cases still visible through current organization-scoped context.
    prior_results = {entry["experimentCode"]: entry["evidence"]
                     for entry in prior.get("sharedAppEvidence", {}).get("experiments", [])
                     if entry["experimentCode"] in contexts and _has_devices(entry["evidence"])}
    ledger = defaultdict(list)
    for entry in dossier["ledgerEntries"]:
        if entry["status"] in {"proposed", "not-evaluated", "inconclusive"}:
            for code in entry["evidenceIdentifiers"]:
                if code in prior_results:
                    ledger[code].append(entry)
    # Prioritize the last report's open, directly linked questions. If none survive,
    # use other open links, then the last report's accepted results for context.
    # With no open question, a context recheck never implies a prediction was tested.
    def tier(code):
        links = ledger.get(code, [])
        if any(metadata["reportId"] in item["sourceReportIds"] for item in links):
            return 0
        return 1 if links else 2

    def priority(code):
        when = latest.get(code)
        return (tier(code), -when.timestamp() if when else float("inf"), code)

    ordered = sorted(prior_results, key=priority)
    # Preserve comparable project coverage within each evidence tier.
    available_tiers = (0, 1) if ledger else (2,)
    for rank in available_tiers:
        waiting = [code for code in ordered if tier(code) == rank]
        while waiting and len(scope["followups"]) < 3:
            projects, deferred = set(), []
            for code in waiting:
                project = contexts[code].get("projectAlias")
                if project in projects:
                    deferred.append(code)
                    continue
                projects.add(project)
                scope["followups"].append({
                    "experimentCode": code, "priorAcceptedSourceHash": prior_results[code]["sourceHash"],
                    "openLedgerEntryIds": sorted(entry["entryId"] for entry in ledger.get(code, [])),
                    "reason": ("OPEN_QUESTION_LAST_PUBLICATION", "OPEN_QUESTION_FROM_PRIOR_LEDGER",
                               "ACCEPTED_DEVICE_CONTEXT_FROM_LAST_EXPORT")[rank],
                })
                if len(scope["followups"]) == 3:
                    break
            waiting = deferred
    scope["requestedExperimentCodes"] = sorted(set(current_codes) | {f["experimentCode"] for f in scope["followups"]})
    return scope


def from_verified_selection(path, snapshot):
    import select_published_baseline as baseline
    from replay_frozen_report import check_published_run, record

    baseline.require_private(path)
    selected = baseline.load_json(path, baseline.MAX_METADATA_BYTES)
    if selected.get("status") != "PUBLISHED_VERIFIED":
        raise ValueError("Verified baseline selection required")
    previous = Path(selected["snapshot"]).parent
    meta = check_published_run(previous)
    if (selected["snapshot"] != str(previous / "snapshot.json")
            or selected["dossierPublished"] != str(previous / "rd-dossier-published.json")
            or any(selected[k] != meta[k] for k in ("reportId", "snapshotSha256", "dossierPublishedSha256", "publicationKey"))):
        raise ValueError("Scope baseline differs from selected verified artifacts")
    return derive(snapshot, record(previous, "snapshot.json", baseline.MAX_ARTIFACT_BYTES),
                  record(previous, "rd-dossier-published.json", baseline.MAX_ARTIFACT_BYTES), meta)


def scope_note(snapshot):
    if snapshot.get("weeklyCollectionScope", {}).get("mode") != "CARRIED_FORWARD":
        return {}
    # Display the real local reporting date rather than truncating a UTC instant.
    zone = ZoneInfo("Asia/Shanghai")
    def shanghai(stamp):
        return shared.timestamp(stamp).astimezone(zone).strftime("%Y-%m-%d %H:%M")
    start, end = (shanghai(snapshot[key]) for key in ("periodStart", "windowEnd"))
    as_of = shanghai(snapshot["sharedAppEvidence"]["asOf"])
    return {
        "bodyEn": f"<p><strong>Follow-up on earlier experiments.</strong> For the week from {start} to {end} (China time), we found no previously unseen eligible instrument measurements dated in that period. We checked the app’s accepted device results again at {as_of}. The device figures include earlier results. A change in the recorded results alone does not date a new device. This week’s decisions focus on which predictions still need a test.</p>",
        "bodyZh": f"<p><strong>前期实验跟进。</strong>本期为北京时间 {start} 至 {end}。本期内测得、符合分析条件且首次出现在报告数据中的仪器测量记录为零。我们于 {as_of} 重新核对了系统采纳的器件结果。器件数值包含前期结果。仅凭系统记录的更新，不能判断新器件何时制备。本周重点是哪些判断仍待实验验证。</p>",
    }


def add_scope_note(document, snapshot):
    note = scope_note(snapshot)
    if note:
        projects = next(section for section in document["sections"] if section["id"] == "projects")
        for key, passage in note.items():
            projects[key] = passage + projects[key]


def verify_scope_note(document, snapshot):
    note = scope_note(snapshot)
    projects = next((section for section in document["sections"] if section["id"] == "projects"), {})
    if any(not projects.get(key, "").startswith(passage) for key, passage in note.items()):
        raise ValueError("Missing bilingual quiet-week description or current accepted-evidence cutoff")
