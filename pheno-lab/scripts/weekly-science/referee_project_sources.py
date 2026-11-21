"""Bounded private context for the final reviewer of the assembled project sections."""
from collections import Counter


def selected_fields(row, names):
    return {name: row[name] for name in names}


def panel_sources(project, review):
    performance = project["periodPerformance"]
    eligible = {
        row["routeCohortId"]: row for row in performance["routeCohorts"]
        if row["view"] == review["analysisView"]
        and row["evidenceTier"] == "SOURCE_LINKED_INSTRUMENT_SCAN"
        and row["inferenceOutcomes"]["nScans"]
    }
    counts = Counter(row["periodCohort"] for row in eligible.values())
    windows = []
    for period in review["periods"]:
        tag = period["period"]
        shown = []
        for item in period["cohorts"]:
            row = eligible[item["cohortId"]]
            if row["periodCohort"] != tag:
                raise ValueError("Referee panel belongs to another source period")
            stats = row["inferenceOutcomes"]
            extremes = row["pceExtremes"]
            shown.append({
                **selected_fields(row, ("routeId", "experimentCode", "group", "direction")),
                "scans": stats["nScans"], "devices": stats["nSamples"],
                "highestScan": extremes["championValidScan"]["pce"],
                "highestDeviceMedian": extremes["bestPhysicalSampleMedian"]["pce"],
                "pce": selected_fields(stats["metrics"]["pce"], ("nSamples", "mean", "median", "sampleStandardDeviation", "iqr")),
                "components": {
                    metric: selected_fields(stats["metrics"][metric], ("mean", "nSamples"))
                    for metric in ("voc", "jsc", "ff") if stats["metrics"].get(metric)
                },
            })
        windows.append({"period": tag, **selected_fields(performance["windows"][tag], ("start", "end")),
                        "eligibleRoutes": counts[tag], "shownRoutes": shown})
    return {"view": review["analysisView"], "periods": windows}


def project_sources(doc, dossier, source, attainment, receipts, decisions, bindings, counts):
    """Reuse the peer-checked strict-route and blinded goal packets; do not send traces or sample IDs."""
    projects = {p["projectAlias"] or "UNASSIGNED": p for p in dossier["projects"]}
    panels = {p["projectAlias"]: p for p in doc["decisionReview"]["projectReviews"]}
    outcomes = {r["project"]: r for r in decisions["projects"]}
    provenance = {r["project"]: r for r in receipts["projects"]}
    goals = {(r["project"], r["experimentCode"], r["sourceHash"]): r for r in attainment["rows"]}
    detailed = {r["experimentCode"] for r in doc["evidenceMethodReview"]["experiments"]}
    visible_issues = {r["entryId"] for r in doc["decisionReview"]["priorIssueReviews"]}
    ledger = {r["entryId"]: r for r in dossier["ledgerEntries"]}
    result = []
    for evidence in source["projects"]:
        key = evidence["project"]
        alias = bindings[key]["projectAlias"] or "UNASSIGNED"
        cases = []
        for case in evidence["routeCases"]:
            code = case["experimentCode"]
            goal = goals[(key, code, case["sourceHash"])]
            cases.append({
                **selected_fields(case, ("experimentCode", "sourceHash", "hashBasis", "name", "observation", "problem",
                                         "hypothesis", "conclusion", "routes")),
                "acceptedDevices": case["currentAccepted"],
                "hasDetailedCase": code in detailed,
                "weeklyScans": counts.get(code, {"inWindow": 0, "firstSeenInWindow": 0}),
                "blindedPurpose": {**selected_fields(goal, ("status", "goalBasis", "reason")),
                                   "linkedEvidenceCount": len(goal["evidenceIds"])},
            })
        refs = {r["key"]: r["entryId"] for r in provenance[key]["issueBindings"]}
        issues = {r["key"]: r for r in outcomes[key]["issueAssessments"]}
        prior = []
        for item in evidence["priorIssues"]:
            entry_id = refs[item["key"]]
            decision = issues[item["key"]]
            after = ledger[entry_id]
            row = {"key": item["key"], "statement": item["statement"], "priorStatus": item["status"],
                   "currentStatus": after["status"], "assessment": decision["assessment"],
                   "testedExperiments": decision["testedExperimentCodes"]}
            if entry_id in visible_issues or decision["testedExperimentCodes"]:
                row.update(entryId=entry_id, previousDecision=item["previousDecision"], rationale=decision["rationale"])
            prior.append(row)
        result.append({
            **selected_fields(evidence, ("project", "name", "assigned", "measuredScans", "earlierReceipts", "firstSeenSources", "scope")),
            "firstSeenInWindow": sum(counts.get(r["experimentCode"], {}).get("firstSeenInWindow", 0) for r in projects[alias]["experiments"]),
            "strictRouteCases": cases, "displayedRouteSources": panel_sources(projects[alias], panels[alias]),
            "priorQuestions": prior,
        })
    if len(result) != len(projects) or {bindings[r["project"]]["projectAlias"] or "UNASSIGNED" for r in result} != set(panels):
        raise ValueError("Referee project evidence is incomplete")
    return result
