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


def scan_timing(snapshot, prior):
    start, end = (shared.timestamp(snapshot[key]) for key in ("periodStart", "windowEnd"))
    contexts = {item["code"] for item in snapshot["experimentSummaries"]}
    previous_scans = audit.raw_scans(prior)
    current_scans = audit.raw_scans(snapshot)
    fresh, latest, in_window = defaultdict(int), {}, defaultdict(int)
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
        if start <= measured_at < end:
            in_window[code] += 1
            if alias not in previous_scans:
                fresh[code] += 1
    return fresh, latest, in_window


def derive(snapshot, prior, dossier, metadata):
    if shared.timestamp(prior["windowEnd"]) >= shared.timestamp(snapshot["windowEnd"]):
        raise ValueError("Weekly scope needs an earlier verified period")
    contexts = {item["code"]: item for item in snapshot["experimentSummaries"]}
    current_codes = shared.selected_experiment_codes(snapshot)
    fresh, latest, _ = scan_timing(snapshot, prior)
    measured = sum(fresh.values())
    scope = {
        "schemaVersion": 1, "policy": "weekly-current-and-prior-followup-v1",
        "mode": "NEW_MEASUREMENTS" if measured else "CARRIED_FORWARD",
        "newEligibleMeasuredAliases": measured, "currentContextCodes": current_codes,
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


def section_notes(document, snapshot, prior=None):
    notes = {}
    general = scope_note(snapshot)
    if general:
        notes["projects"] = general
    if prior is None:
        return notes
    fresh, _, windows = scan_timing(snapshot, prior)
    for case in document["evidenceMethodReview"]["experiments"]:
        code = case["experimentCode"]
        count = fresh.get(code, 0)
        seen = windows.get(code, 0) - count
        if count:
            unit = "scan" if count == 1 else "scans"
            en = f"This reporting week contributed {count} previously unseen eligible instrument {unit} for this experiment. The device statistics below use the full set of accepted results at the cutoff."
            zh = f"本实验有 {count} 条本期新测且首次纳入报告的有效仪器扫描记录。下文的器件统计包含截至本期的全部采纳结果。"
        elif seen:
            subject = "The one eligible instrument scan" if seen == 1 else f"All {seen} eligible instrument scans"
            verb = "was" if seen == 1 else "were"
            en = f"Earlier results revisited. {subject} dated within this reporting week {verb} already available in the preceding report’s data. This comparison follows up the earlier result."
            zh = f"前期结果跟进。本实验测量日期在本周内的 {seen} 条有效扫描，上期报告采集数据时均已收录。此次比较用于跟进此前的结果。"
        else:
            en = "Earlier results revisited. This experiment has no newly observed eligible instrument scans dated within this reporting week. The comparison uses cumulative accepted device results."
            zh = "前期结果跟进。本实验没有本周新测且首次纳入报告的有效仪器扫描。此次比较使用累计采纳的器件结果。"
        notes[case["sectionId"]] = {"bodyEn": "<p>" + en + "</p>", "bodyZh": "<p>" + zh + "</p>"}
    return notes


def add_scope_note(document, snapshot, prior=None):
    sections = {section["id"]: section for section in document["sections"]}
    for sid, notes in section_notes(document, snapshot, prior).items():
        for key, passage in notes.items():
            sections[sid][key] = passage + sections[sid][key]


def verify_scope_note(document, snapshot, prior=None):
    sections = {section["id"]: section for section in document["sections"]}
    for sid, notes in section_notes(document, snapshot, prior).items():
        if any(not sections.get(sid, {}).get(key, "").startswith(passage) for key, passage in notes.items()):
            raise ValueError("Missing bilingual follow-up status or fresh measurement count")

def verify_followup_timing(snapshot, previous, public_index, decisions, bindings):
    fresh, _, _ = scan_timing(snapshot, previous)
    for assessment in public_index["followupAssessments"]:
        if assessment["assessment"] != "no-new-direct-test" and not fresh.get(
                bindings["cases"][assessment["experiment"]]["code"]):
            raise ValueError("Previously seen measurements cannot establish a newly conducted follow-up test")
    for project in decisions["projects"]:
        for assessment in project["issueAssessments"]:
            if assessment["assessment"] != "no-new-direct-test" and not (
                assessment["testedExperimentCodes"] and all(fresh.get(code) for code in assessment["testedExperimentCodes"])
            ):
                raise ValueError("A project follow-up claim needs genuinely new measurements in every cited experiment")
