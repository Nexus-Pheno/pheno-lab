#!/usr/bin/env python3
"""Private, source-bound project R&D dossier; no causal model or publication.

This helper never reproduces molecular definitions. It computes descriptive
evidence, records the limits of treatment/protocol matching, and carries an
append-only decision ledger. An agent still has to interpret the evidence and
review the bilingual report before publication.
"""
import argparse
from collections import Counter, defaultdict
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics

_shared_spec = importlib.util.spec_from_file_location('shared_app_evidence', Path(__file__).with_name('shared_app_evidence.py'))
shared_app_evidence = importlib.util.module_from_spec(_shared_spec)
_shared_spec.loader.exec_module(shared_app_evidence)


METRICS = ("pce", "voc", "jsc", "ff")
LEDGER_STATUSES = {"proposed", "not-evaluated", "inconclusive", "supported", "contradicted", "retired"}
LEDGER_TYPES = {"hypothesis", "recommendation"}
PRIVATE_CLASSIFICATION = "PRIVATE_RD_DOSSIER_DO_NOT_PUBLISH_RAW"


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("An offset-aware timestamp is required")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("An offset-aware timestamp is required")
    return parsed


def in_interval(value, start, end):
    try:
        return start <= timestamp(value) < end
    except (ValueError, TypeError):
        return False


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def text(value):
    return str(value).strip() if value is not None else ""


def quantile(values, probability):
    ordered = sorted(values)
    if not ordered:
        return None
    offset = (len(ordered) - 1) * probability
    lo, hi = math.floor(offset), math.ceil(offset)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (offset - lo)


def describe(values):
    values = [value for value in values if finite(value)]
    median = statistics.median(values) if values else None
    q1, q3 = quantile(values, .25), quantile(values, .75)
    return {"nSamples": len(values), "mean": statistics.mean(values) if values else None, "median": median,
            "q1": q1, "q3": q3, "iqr": q3 - q1 if values else None,
            "min": min(values) if values else None, "max": max(values) if values else None,
            "sampleStandardDeviation": statistics.stdev(values) if len(values) > 1 else None,
            "medianAbsoluteDeviation": statistics.median([abs(v - median) for v in values]) if values else None,
            "dispersionEvidence": "INSUFFICIENT_SAMPLES" if len(values) < 2 else "DESCRIPTIVE_DEVICE_DISPERSION"}


def material_alias(material):
    return material.get("materialAlias") or material.get("id")


def project_key(experiment):
    project = experiment.get("project") or {}
    alias = experiment.get("projectAlias") or project.get("projectAlias")
    # An explicit review bucket is not an inferred project. Its experiments
    # remain individually listed and cannot establish cross-project treatment.
    return alias or "UNASSIGNED"


def project_metadata(experiment):
    project = experiment.get("project") or {}
    return {"projectAlias": experiment.get("projectAlias") or project.get("projectAlias"),
            "projectName": experiment.get("projectName") or project.get("name"),
            "projectCode": experiment.get("projectCode") or project.get("code"),
            "assigned": bool(experiment.get("projectAlias") or project.get("projectAlias")),
            "projectIdentityBasis": "CANONICAL_PROJECT_RELATION" if experiment.get("projectAlias") or project.get("projectAlias") else "UNASSIGNED_REVIEW_BUCKET"}


def parameter_value(parameter, group):
    matches = [v for v in parameter.get("variations", []) if v.get("variationGroup") == group]
    if len(matches) > 1:
        return None, "ambiguous_parameter_variation"
    return matches[0].get("value") if matches else parameter.get("value"), None


def recipe_composition_available(recipe):
    payload = recipe.get("payload")
    if not isinstance(payload, dict):
        return False
    components = payload.get("components") or payload.get("ingredients") or recipe.get("ingredients")
    # A recipe name, notes, or arbitrary nonempty payload alone is not composition.
    return isinstance(components, list) and bool(components) and all(
        isinstance(x, dict) and text(x.get("material")) and text(x.get("amount")) for x in components)


def condition_signature(experiment, measurement):
    """Match recorded treatment content, never infer equality from group labels."""
    issues, planned, actual = [], [], []
    if not experiment.get("steps"):
        issues.append("missing_process_steps")
    if not any(step.get("recipe") for step in experiment.get("steps", [])):
        issues.append("missing_perovskite_recipe_context")
    aliases = set()
    for index, step in enumerate(experiment.get("steps", [])):
        layer, process = text(step.get("layer")), step.get("process") or {}
        if not layer:
            issues.append("missing_device_layer")
        process_identity = process.get("processAlias") or process.get("id") or process.get("name")
        if not process_identity:
            issues.append("missing_process_identity")
        recipe = step.get("recipe")
        recipe_value = None
        if recipe:
            if not recipe_composition_available(recipe):
                issues.append("missing_recipe_composition")
            if not recipe.get("recipeAlias") and not recipe.get("id"):
                issues.append("missing_recipe_identity")
            payload = recipe.get("payload") or {}
            if not isinstance(payload, dict) or not text(payload.get("solvents")):
                issues.append("missing_recipe_solvent_specification")
            if not isinstance(payload, dict) or not text(payload.get("concentration")):
                issues.append("missing_recipe_concentration")
            recipe_value = {"recipeAlias": recipe.get("recipeAlias") or recipe.get("id"),
                            "payload": recipe.get("payload"), "ingredients": recipe.get("ingredients")}
            issues.append("recipe_is_current_plan_not_captured_actual_composition")
            if recipe.get("ingredientLinkBasis") == "RECORDED_TEXT_NOT_RELATIONAL_MATERIAL_IDS":
                issues.append("recipe_ingredient_identity_not_relationally_verified")
        materials = []
        for item in step.get("materials", []):
            material = item.get("material") or {}
            alias = material_alias(material)
            if alias:
                aliases.add(alias)
            else:
                issues.append("missing_material_identity")
            if not material.get("category"):
                issues.append("missing_material_category")
            amount = text(item.get("amount"))
            # Schema stores dose and unit as one free-text amount. Require a
            # separate unit or explicit unit text; do not invent mol%/mg/mL.
            unit = text(item.get("unit"))
            has_unit = bool(unit or (amount and any(c.isalpha() or c in "%µμ" for c in amount)))
            if not amount:
                issues.append("missing_material_dose")
            if not has_unit:
                issues.append("missing_material_dose_unit")
            materials.append({"materialAlias": alias, "category": material.get("category"),
                              "amount": amount, "unit": unit})
        parameters = []
        for parameter in step.get("parameters", []):
            value, issue = parameter_value(parameter, measurement.get("group"))
            if issue:
                issues.append(issue)
            if not text(value):
                issues.append("missing_planned_parameter_value")
            try:
                numeric_value = float(value)
            except (ValueError, TypeError):
                numeric_value = None
            if numeric_value is not None and not text(parameter.get("unit")):
                issues.append("missing_numeric_parameter_unit")
            # Unitless categorical selectors are valid recorded values; empty
            # units are retained and cannot be silently normalized.
            parameters.append({"name": parameter.get("name"), "unit": parameter.get("unit"),
                               "source": parameter.get("source"), "value": value})
        planned.append({"position": step.get("position", index), "layer": layer,
                        "process": process_identity, "recipe": recipe_value,
                        "materials": sorted(materials, key=canonical),
                        "parameters": sorted(parameters, key=canonical),
                        "environmentConditions": step.get("environmentConditions")})
        executions = [x for x in step.get("executions", [])
                      if x.get("sampleAlias") == measurement.get("sampleAlias") and x.get("runAlias") == measurement.get("runAlias")]
        if len(executions) != 1:
            issues.append("missing_or_ambiguous_sample_run_actuals")
            actual.append(None)
            continue
        execution = executions[0]
        if execution.get("flagged"):
            issues.append("flagged_execution")
        actuals = execution.get("actuals")
        if not isinstance(actuals, dict) or not actuals:
            issues.append("missing_actual_parameter_capture")
        if not execution.get("capturedAt"):
            issues.append("missing_actual_capture_time")
        else:
            try:
                if measurement.get("measuredAt") and timestamp(execution["capturedAt"]) > timestamp(measurement["measuredAt"]):
                    issues.append("actual_capture_postdates_measurement")
            except ValueError:
                issues.append("invalid_actual_capture_time")
        selections = []
        for selection in execution.get("materialSelections", []):
            material = selection.get("material") or {}
            alias = material_alias(material)
            if alias:
                aliases.add(alias)
            else:
                issues.append("missing_actual_material_identity")
            selections.append({"parameterName": selection.get("parameterName"), "materialAlias": alias,
                               "category": material.get("category"), "lot": material.get("lot")})
        actual.append({"actuals": actuals, "environmentConditions": execution.get("environmentConditions"),
                       "materialSelections": sorted(selections, key=canonical)})
    # Current plans, group assignment and library cards can change after the
    # experiment. Only explicit immutable-condition provenance can resolve it.
    provenance = measurement.get("conditionProvenance") or {}
    verified = provenance.get("verified") is True and bool(provenance.get("evidenceIdentifiers"))
    if not verified:
        issues.append("historical_treatment_provenance_unverified")
    identity_issues = {"missing_process_steps", "missing_perovskite_recipe_context", "missing_device_layer", "missing_process_identity", "missing_recipe_composition",
                       "missing_recipe_solvent_specification", "missing_recipe_concentration", "missing_material_category",
                       "missing_recipe_identity", "missing_material_identity", "missing_material_dose", "missing_material_dose_unit",
                       "missing_planned_parameter_value", "missing_numeric_parameter_unit", "ambiguous_parameter_variation"}
    actual_issues = {"missing_or_ambiguous_sample_run_actuals", "flagged_execution", "missing_actual_parameter_capture",
                     "missing_actual_capture_time", "invalid_actual_capture_time", "actual_capture_postdates_measurement",
                     "missing_actual_material_identity", "recipe_is_current_plan_not_captured_actual_composition"}
    return {"plannedSignature": digest(planned), "actualSignature": digest(actual),
            "conditionSignature": digest({"planned": planned, "actual": actual}),
            "plannedIdentityComplete": not identity_issues.intersection(issues),
            "actualCaptureComplete": not actual_issues.intersection(issues),
            "historicalProvenanceVerified": verified,
            "issues": sorted(set(issues)), "materialAliases": sorted(aliases),
            "metadataBasis": "CURRENT_AT_SNAPSHOT_UNLESS_EXPLICIT_PROVENANCE"}


def protocol_signature(row):
    issues = []
    settings, area = row.get("settings"), (row.get("metrics") or {}).get("area")
    if not isinstance(settings, dict) or not settings:
        issues.append("missing_measurement_settings")
    if not finite(area) or area <= 0:
        issues.append("missing_or_invalid_area")
    if row.get("direction") not in {"REVERSE", "FORWARD"}:
        issues.append("missing_or_unknown_scan_direction")
    if not row.get("runAlias"):
        issues.append("missing_run_link")
    if row.get("runLinkStatus") and row["runLinkStatus"] != "SAME_EXPERIMENT":
        issues.append("unverified_or_wrong_experiment_run_link")
    area_definition = row.get("areaDefinition") or (settings.get("areaDefinition") if isinstance(settings, dict) else None)
    if not area_definition or text(area_definition).upper() in {"UNVERIFIED", "UNKNOWN", "MISSING", "UNSPECIFIED"}:
        issues.append("unverified_area_definition")
    metric_units = row.get("metricUnits")
    if not isinstance(metric_units, dict) or not all(metric_units.get(key) for key in METRICS):
        issues.append("unverified_metric_units")
    return {"settingsHash": digest(settings), "area": area, "areaDefinition": area_definition,
            "metricUnits": metric_units, "issues": issues,
            "protocolSignature": digest({"settings": settings, "area": area,
                                         "areaDefinition": area_definition, "metricUnits": metric_units,
                                         "direction": row.get("direction"), "condition": row.get("condition")})}


def chemistry_evidence(snapshot, aliases, measurement_times):
    available = snapshot.get("chemistryAccessAvailable") is True
    definitions = {material_alias(x): x for x in snapshot.get("privateChemistryDefinitions", []) if material_alias(x)} if available else {}
    result = []
    for alias in sorted(aliases):
        definition = definitions.get(alias)
        status, current_validated, postdates = "NO_DEFINITION", False, None
        version, generated = None, None
        if definition:
            chemistry = definition.get("chemistry") or {}
            version, generated = chemistry.get("version"), chemistry.get("generatedAt")
            smiles = definition.get("smiles")
            input_hash = hashlib.sha256(smiles.encode()).hexdigest() if isinstance(smiles, str) and smiles.strip() else None
            status = "NO_EVIDENCE" if input_hash else "NO_DEFINITION"
            if input_hash and chemistry:
                status = "MATCH" if input_hash == chemistry.get("inputSha256") else "MISMATCH"
                current_validated = status == "MATCH" and bool(chemistry.get("canonicalSmiles")) and bool(version) and bool(generated)
            if generated:
                try:
                    postdates = any(timestamp(generated) > timestamp(at) for at in measurement_times if at)
                except ValueError:
                    postdates = None
        result.append({"materialAlias": alias, "name": definition.get("name") if definition else None,
                       "category": definition.get("category") if definition else None,
                       "hashValidationStatus": status, "currentValidatedDefinition": current_validated,
                       "definitionVersion": version, "definitionGeneratedAt": generated,
                       "definitionPostdatesSomeMeasurements": postdates,
                       "historicalMaterialIdentity": "UNVERIFIED",
                       "chemistryAccessAvailable": available,
                       "limitation": "Validated current graph is not proof of historical lot, purity, mixture or device behavior."})
    return result


def scan_identity(row):
    # Period/receipt flags may differ across overlapping snapshots; scientific
    # linkage and recorded values must agree for a durable source ID.
    return {key: row.get(key) for key in ("experimentCode", "projectAlias", "sampleAlias", "runAlias", "group", "direction",
                                         "condition", "metrics", "settings", "measuredAt", "receivedAt", "timeBasis")}


def unique_measurements(snapshot):
    combined = snapshot.get("historicalSampleMeasurements", []) + snapshot.get("sampleMeasurements", [])
    seen, conflicts, legacy = {}, set(), []
    duplicates = 0
    for index, row in enumerate(combined):
        alias = row.get("measurementAlias")
        if not alias:
            legacy.append(("snapshot-local-unverified-" + str(index), copy.deepcopy(row)))
        elif alias in seen:
            duplicates += 1
            if scan_identity(row) != scan_identity(seen[alias]):
                conflicts.add(alias)
        else:
            seen[alias] = copy.deepcopy(row)
    return [(key, row) for key, row in seen.items() if key not in conflicts] + legacy, {
        "inputRows": len(combined), "duplicateSourceRowsRemoved": duplicates,
        "conflictingSourceAliases": sorted(conflicts), "missingStableMeasurementAliasRows": len(legacy),
        "uniqueRowsWithUnverifiedLegacyRows": len(seen) - len(conflicts) + len(legacy)}


def sample_summary(rows):
    samples = defaultdict(list)
    for row in rows:
        samples[row["sampleAlias"]].append(row)
    values, summaries = {key: [] for key in METRICS}, []
    for alias, scans in sorted(samples.items()):
        metrics = {}
        for key in METRICS:
            available = [r["metrics"].get(key) for r in scans if finite(r["metrics"].get(key))]
            metrics[key] = {"median": statistics.median(available) if available else None, "nScans": len(available)}
            if available:
                values[key].append(metrics[key]["median"])
        summaries.append({"sampleAlias": alias, "nScans": len(scans), "metrics": metrics,
                          "measurementAliases": sorted(r["evidenceIdentifier"] for r in scans)})
    batch_aliases, batch_coverage = set(), 0
    for row in rows:
        evidence = row.get("independentBatchEvidence") or {}
        if evidence.get("independenceVerified") is True and evidence.get("manufacturingBatchAlias") and evidence.get("evidenceIdentifiers"):
            batch_aliases.add(evidence["manufacturingBatchAlias"])
            batch_coverage += 1
    return {"nSamples": len(samples), "nScans": len(rows), "sampleOutcomes": summaries,
            "metrics": {key: describe(values[key]) for key in METRICS},
            "verifiedIndependentManufacturingBatches": len(batch_aliases),
            "independentBatchCount": len(batch_aliases) if batch_coverage == len(rows) and rows else None,
            "independentBatchStatus": "EXPLICIT_PROVENANCE" if batch_coverage == len(rows) and rows else "UNVERIFIED",
            "batchProvenanceScanCoverage": batch_coverage,
            "replicationCaution": "Scans, pixels, linked runs, time windows and sample dispersion do not establish independent manufacturing replication."}


def metric_diagnostics(row):
    metrics, units = row.get("metrics") or {}, row.get("metricUnits") or {}
    inconsistent, trace_flags = [], []
    if finite(metrics.get("pce")) and metrics["pce"] > 0:
        for key in ("voc", "jsc"):
            if finite(metrics.get(key)) and metrics[key] <= 0:
                inconsistent.append("positive_pce_with_nonpositive_" + key)
    if units.get("ff") in {"%", "percent", "PERCENT"} and finite(metrics.get("ff")) and not 0 < metrics["ff"] <= 100:
        inconsistent.append("recorded_percent_ff_outside_0_to_100")
    points = (row.get("settings") or {}).get("points") if isinstance(row.get("settings"), dict) else None
    if finite(points) and points < 2:
        trace_flags.append("recorded_jv_trace_has_fewer_than_two_points")
    missing = [key for key in METRICS if not finite(metrics.get(key))]
    return {"internallyInconsistentMetricReasons": inconsistent, "traceQualityFlags": trace_flags,
            "missingMetricKeys": missing, "ffUnitVerifiedPercent": units.get("ff") in {"%", "percent", "PERCENT"},
            "performanceInferenceEligible": not inconsistent,
            "interpretation": "Source retained. Explicit inconsistent vectors are excluded only from performance inference; missing metrics/units stay unverified. No PCE formula check or unit reconstruction."}


def inference_outcomes(rows):
    allowed = [row for row in rows if row["metricDiagnostics"]["performanceInferenceEligible"]]
    return sample_summary(allowed) | {"originalDescriptiveScanCount": len(rows),
        "internallyInconsistentScanCountExcluded": len(rows) - len(allowed),
        "inferenceExclusionBasis": "Explicit recorded metric inconsistency only; source rows are retained in quality inventory"}


def pce_extremes(rows):
    """Separate a scan champion from the best physical-sample median.

    The caller supplies only one recorded-condition/protocol/time cohort.
    Neither endpoint is a stabilized efficiency or a manufacturing yield.
    """
    allowed = [row for row in rows if row["metricDiagnostics"]["performanceInferenceEligible"]]
    if not allowed:
        return {"championValidScan": None, "bestPhysicalSampleMedian": None}
    champion = max(row["metrics"]["pce"] for row in allowed)
    tied = [row for row in allowed if row["metrics"]["pce"] == champion]
    samples = sample_summary(allowed)["sampleOutcomes"]
    best_median = max(sample["metrics"]["pce"]["median"] for sample in samples)
    return {"championValidScan": {"pce": champion,
                "measurementAliases": sorted(row["evidenceIdentifier"] for row in tied),
                "sampleAliases": sorted({row["sampleAlias"] for row in tied}),
                "nTiedScans": len(tied),
                "definition": "Maximum recorded PCE scan passing the descriptive and explicit metric-consistency gates in this cohort; not stabilized/certified efficiency"},
            "bestPhysicalSampleMedian": {"pce": best_median,
                "sampleAliases": sorted(sample["sampleAlias"] for sample in samples if sample["metrics"]["pce"]["median"] == best_median),
                "definition": "Maximum of physical-sample PCE scan medians in this cohort; repeated scans do not give a sample more weight"}}


def recorded_design_intent(experiment):
    """Retain source wording, without treating legacy field labels as chronology."""
    fields = ("observation", "problem", "hypothesis", "conclusion")
    metadata = experiment.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    return {"sourceFields": {key: copy.deepcopy(experiment.get(key)) for key in fields},
            "sourceFieldAvailability": {key: "RECORDED_NONEMPTY" if text(experiment.get(key)) else
                "RECORDED_EMPTY" if key in experiment else "NOT_COLLECTED" for key in fields},
            "sourceMetadataTestPlan": copy.deepcopy(metadata.get("testPlan")),
            "sourceMetadataTestPlanAvailable": "testPlan" in metadata,
            "sourceTimestamps": {key: experiment.get(key) for key in
                ("createdAt", "updatedAt", "submittedAt", "approvedAt")},
            "metadataBasis": "CURRENT_AT_SNAPSHOT_NOT_A_RECONSTRUCTED_PRE_EXPERIMENT_DESIGN",
            "semanticCaution": "Legacy source fields may mean experiment purpose, DOE design or failure analysis. Retain exact wording; a field name or update timestamp does not establish an original hypothesis or when its statement was authored.",
            "assessmentStatus": "REQUIRES_REVIEWED_INTENT_RESULT_AND_PLAN_VERSUS_ACTUAL_RECONCILIATION",
            "nextDesignOutcomesCriteriaAndBranches": "REPORT_PROPOSALS_ONLY_NOT_INFERRED_SOURCE_RECORDS"}


def period_performance(rows, period, end, history):
    """Source-bound equal-period panels; never pool unrelated project routes.

    Strict routes retain full settings. A second, explicitly unverified view
    removes only traceName, preserving every recorded condition and test field.
    Runs are never declared independent manufacturing batches.
    """
    previous_start = period - (end - period)
    windows = {"CURRENT_PERIOD": (period, end),
               "PREVIOUS_EQUAL_DURATION_PERIOD": (previous_start, period),
               "EARLIER_HISTORY": (history, min(previous_start, end))}
    previous_complete = history <= previous_start
    grouped = {"STRICT_RECORDED_PROTOCOL": defaultdict(list),
               "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL": defaultdict(list)}
    undated = 0
    for row in rows:
        if not row.get("measuredAt"):
            undated += 1
            continue
        cohort = next((label for label, (start, stop) in windows.items()
                       if start < stop and in_interval(row["measuredAt"], start, stop)), None)
        if not cohort:
            continue
        protocol = row["protocolEvidence"]
        hard_missing = {"missing_run_link", "unverified_or_wrong_experiment_run_link", "missing_measurement_settings",
                        "missing_or_invalid_area", "missing_or_unknown_scan_direction"}.intersection(protocol["issues"])
        base = (row["experimentCode"], row.get("runAlias"), row.get("group"), row.get("instrumentAlias"),
                row.get("direction"), row["conditionEvidence"]["conditionSignature"], row["evidenceTier"])
        # Missing identity/protocol is not evidence that two nulls are equal.
        separation = row["evidenceIdentifier"] if hard_missing else None
        strict = base + (protocol["protocolSignature"], separation)
        grouped["STRICT_RECORDED_PROTOCOL"][(strict, cohort)].append(row)
        limited = exploratory_protocol(row)
        if not hard_missing and isinstance(limited["recordedLimitedSettings"], dict) and limited["recordedLimitedSettings"]:
            limited_key = base + (digest({"settingsHash": limited["exploratorySettingsHash"],
                "area": protocol["area"], "areaDefinition": protocol["areaDefinition"],
                "metricUnits": protocol["metricUnits"], "condition": row.get("condition")}), None)
            grouped["TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL"][(limited_key, cohort)].append(row)
    panels, comparisons = [], []
    for view, groups in grouped.items():
        routes = defaultdict(dict)
        for (key, cohort), scans in sorted(groups.items(), key=lambda item: canonical(item[0])):
            row = scans[0]
            limited = exploratory_protocol(row)
            issues = set(row["conditionEvidence"]["issues"] + row["protocolEvidence"]["issues"])
            if view == "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL":
                issues.update("unrecorded_" + field for field in limited["unrecordedProtocolFields"])
                issues.add("trace_identity_excluded_limited_protocol_not_verified")
            if not row.get("instrumentAlias"):
                issues.add("missing_instrument_identity")
            if row["evidenceTier"] != "SOURCE_LINKED_INSTRUMENT_SCAN":
                issues.add("source_scan_lineage_unverified")
            route_id = "period-route-" + digest({"view": view, "key": key})[:24]
            panel = {"routeCohortId": route_id + ":" + cohort, "routeId": route_id, "view": view,
                "periodCohort": cohort, "experimentCode": row["experimentCode"], "runAlias": row.get("runAlias"),
                "group": row.get("group"), "instrumentAlias": row.get("instrumentAlias"),
                "direction": row.get("direction"), "evidenceTier": row["evidenceTier"],
                "routeIdentityBasis": "RECORDED_EXPERIMENT_RUN_GROUP_CONDITION_AND_PROTOCOL_SIGNATURES_NOT_NAME_INFERENCE",
                "conditionSignature": row["conditionEvidence"]["conditionSignature"],
                "plannedSignature": row["conditionEvidence"]["plannedSignature"],
                "actualSignature": row["conditionEvidence"]["actualSignature"],
                "fullRecordedProtocolSignatures": sorted({r["protocolEvidence"]["protocolSignature"] for r in scans}),
                "fullSettingsHashes": sorted({r["protocolEvidence"]["settingsHash"] for r in scans}),
                "measurementAliases": sorted(r["evidenceIdentifier"] for r in scans if r["metricDiagnostics"]["performanceInferenceEligible"]),
                "descriptiveMeasurementAliases": sorted(r["evidenceIdentifier"] for r in scans),
                "excludedIdentityKeys": ["traceName"] if view == "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL" and
                    any("traceName" in (r.get("settings") or {}) for r in scans) else [],
                "comparabilityIssues": sorted(issues), "metricUnits": row["protocolEvidence"]["metricUnits"],
                "inferenceOutcomes": inference_outcomes(scans), "pceExtremes": pce_extremes(scans),
                "withinDeviceDispersion": [{"sampleAlias": alias,
                    "metrics": {metric: {("nScans" if key == "nSamples" else key): value for key, value in
                        describe([r["metrics"].get(metric) for r in sample_rows]).items()} |
                        {"denominatorUnit": "SCANS_WITHIN_ONE_PHYSICAL_SAMPLE"} for metric in METRICS}}
                    for alias, sample_rows in sorted(_rows_by_sample([r for r in scans if r["metricDiagnostics"]["performanceInferenceEligible"]]).items())],
                "meanDefinition": "Arithmetic mean across physical-sample scan medians, separately for each metric and its available-sample denominator",
                "dispersionDefinition": "Between-sample IQR/SD/MAD of physical-sample medians; within-device scan dispersion is separate; neither establishes independent manufacturing repeatability"}
            panels.append(panel)
            routes[route_id][cohort] = panel
        for route_id, cohorts in sorted(routes.items()):
            current = cohorts.get("CURRENT_PERIOD")
            for reference in ("PREVIOUS_EQUAL_DURATION_PERIOD", "EARLIER_HISTORY"):
                old = cohorts.get(reference)
                issues = set((current or old or next(iter(cohorts.values())))["comparabilityIssues"])
                unavailable = []
                if not current:
                    unavailable.append("NO_CURRENT_PERIOD_MEASURED_COHORT")
                elif not current["inferenceOutcomes"]["nSamples"]:
                    unavailable.append("NO_CURRENT_PERIOD_INFERENCE_ELIGIBLE_PHYSICAL_SAMPLES")
                if not old:
                    unavailable.append("NO_REFERENCE_MEASURED_COHORT_IN_EXACT_RECORDED_ROUTE")
                elif not old["inferenceOutcomes"]["nSamples"]:
                    unavailable.append("NO_REFERENCE_INFERENCE_ELIGIBLE_PHYSICAL_SAMPLES")
                if reference == "PREVIOUS_EQUAL_DURATION_PERIOD" and not previous_complete:
                    unavailable.append("PREVIOUS_PERIOD_NOT_FULLY_COVERED_BY_SOURCE_HISTORY")
                if old:
                    issues.update(old["comparabilityIssues"])
                def metric_delta(metric, statistic):
                    if unavailable:
                        return None
                    present_value = current["inferenceOutcomes"]["metrics"][metric][statistic]
                    previous_value = old["inferenceOutcomes"]["metrics"][metric][statistic]
                    return present_value - previous_value if finite(present_value) and finite(previous_value) else None
                shared = None if unavailable else len({s["sampleAlias"] for s in current["inferenceOutcomes"]["sampleOutcomes"]} &
                    {s["sampleAlias"] for s in old["inferenceOutcomes"]["sampleOutcomes"]})
                comparisons.append({"routeId": route_id, "view": view, "referencePeriod": reference,
                    "currentCohortId": current["routeCohortId"] if current else None,
                    "referenceCohortId": old["routeCohortId"] if old else None,
                    "comparisonStatus": "UNAVAILABLE" if unavailable else
                        "CONDITIONAL_DESCRIPTIVE_COMPARISON_UNVERIFIED" if issues else "MATCHED_RECORDED_CONDITIONS_DESCRIPTIVE_ONLY",
                    "unavailableReasons": unavailable, "comparabilityIssues": sorted(issues),
                    "metricDifferencesCurrentMinusReference": {metric: {statistic: metric_delta(metric, statistic)
                        for statistic in ("mean", "median", "iqr", "sampleStandardDeviation")} for metric in METRICS},
                    "pceExtremesDifferencesCurrentMinusReference": {endpoint: None if unavailable else
                        current["pceExtremes"][endpoint]["pce"] - old["pceExtremes"][endpoint]["pce"]
                        for endpoint in ("championValidScan", "bestPhysicalSampleMedian")},
                    "sharedPhysicalSamples": shared, "independentManufacturingReplicationVerified": False,
                    "interpretation": "Same recorded route only. Missing reference/protocol evidence is not a resolved question or fabrication gain. No causal ranking, yield or independent-batch claim."})
    return {"windows": {label: {"start": start.isoformat(), "end": stop.isoformat(),
                "availableSourceStart": max(start, history).isoformat(), "nonempty": start < stop,
                "fullSourceCoverage": history <= start} for label, (start, stop) in windows.items()},
            "undatedMeasurementRowsExcludedFromPeriodPerformance": undated,
            "routeCohorts": panels, "routeComparisons": comparisons,
            "projectPooledPerformance": None,
            "poolingPolicy": "No project-wide mean/champion across unlike recorded routes or protocols. Empty route windows and noncomparability are explicit; receipt-only rows do not become measured gains."}


def _rows_by_sample(rows):
    samples = defaultdict(list)
    for row in rows:
        samples[row["sampleAlias"]].append(row)
    return samples


def comparison_pairs(strata):
    current, history = defaultdict(list), defaultdict(list)
    for stratum in strata:
        if stratum["evidenceTier"] != "SOURCE_LINKED_INSTRUMENT_SCAN" or not stratum["conditionEvidence"]["plannedIdentityComplete"]:
            continue
        # Unknown recorded settings/direction/area cannot match another unknown.
        hard_missing = {"missing_measurement_settings", "missing_or_invalid_area", "missing_or_unknown_scan_direction", "missing_run_link", "unverified_or_wrong_experiment_run_link"}
        if hard_missing.intersection(stratum["protocolEvidence"]["issues"]):
            continue
        if not stratum.get("inferenceOutcomes", stratum)["nSamples"]:
            continue
        key = (stratum["conditionEvidence"]["plannedSignature"], stratum["protocolEvidence"]["protocolSignature"])
        if stratum["periodCohort"] == "CURRENT_WEEK_MEASURED":
            current[key].append(stratum)
        elif stratum["periodCohort"] == "HISTORY_MEASURED":
            history[key].append(stratum)
    comparisons = []
    for key in sorted(set(current) & set(history)):
        for present in current[key]:
            for previous in history[key]:
                issues = sorted(set(present["comparabilityIssues"] + previous["comparabilityIssues"]))
                if present["conditionEvidence"]["actualSignature"] != previous["conditionEvidence"]["actualSignature"]:
                    issues.append("recorded_actual_conditions_differ")
                present_samples = {s["sampleAlias"] for s in present["inferenceOutcomes"]["sampleOutcomes"]}
                previous_samples = {s["sampleAlias"] for s in previous["inferenceOutcomes"]["sampleOutcomes"]}
                overlap = present_samples & previous_samples
                comparisons.append({"currentStratumId": present["stratumId"], "historicalStratumId": previous["stratumId"],
                    "currentExperimentCode": present["experimentCode"], "historicalExperimentCode": previous["experimentCode"],
                    "matchBasis": "IDENTICAL_RECORDED_PLANNED_CONTENT_AND_PROTOCOL",
                    "comparabilityStatus": "VERIFIED_RECORDED_CONDITIONS" if not issues else "UNVERIFIED_COMPARABILITY",
                    "issues": sorted(set(issues)), "sharedPhysicalSamples": len(overlap),
                    "currentSamplesNotInHistoricalStratum": len(present_samples - previous_samples),
                    "independentManufacturingReplicationVerified": False,
                    "pceMedianDifferencePercentagePoints": present["inferenceOutcomes"]["metrics"]["pce"]["median"] - previous["inferenceOutcomes"]["metrics"]["pce"]["median"],
                    "interpretation": "Descriptive contrast only; overlapping physical samples are repeated observations, not new devices. No causal effect or validated ranking."})
    return comparisons


def exploratory_protocol(row):
    """Remove only the trace's identity label; keep all recorded test fields.

    This is explicitly an exploratory representation, never a verified test
    protocol. Sparse legacy settings do not record rate/conditioning merely
    because points or a numerical free-text note happen to be present.
    """
    settings = row.get("settings")
    limited = {key: value for key, value in settings.items() if key != "traceName"} if isinstance(settings, dict) else settings
    fields = limited if isinstance(limited, dict) else {}
    missing = [key for key in ("scanRate", "irradiance", "preconditioning", "delay", "deviceTemperature")
               if fields.get(key) is None or fields.get(key) == ""]
    if not row.get("runAlias") or row.get("runLinkStatus") not in {None, "SAME_EXPERIMENT"}:
        missing.append("verifiedRunLink")
    if not row.get("instrumentAlias"):
        missing.append("instrumentIdentity")
    area_definition = row.get("areaDefinition") or fields.get("areaDefinition")
    if not area_definition or text(area_definition).upper() in {"UNVERIFIED", "UNKNOWN", "MISSING", "UNSPECIFIED"}:
        missing.append("apertureOrActiveAreaDefinition")
    return {"originalFullSettingsHash": digest(settings), "exploratorySettingsHash": digest(limited),
            "recordedLimitedSettings": limited,
            "excludedIdentityKeys": ["traceName"] if isinstance(settings, dict) and "traceName" in settings else [],
            "exclusionReason": "traceName identifies the specimen/trace; all other recorded settings remain distinct",
            "unrecordedProtocolFields": missing,
            "equivalenceStatus": "LIMITED_RECORDED_PROTOCOL_ONLY_UNVERIFIED"}


def exploratory_strata_and_contrasts(rows):
    grouped, repeated = defaultdict(list), defaultdict(list)
    for row in rows:
        if row.get("evidenceTier") != "SOURCE_LINKED_INSTRUMENT_SCAN":
            continue
        protocol = exploratory_protocol(row)
        if not isinstance(protocol["recordedLimitedSettings"], dict) or not protocol["recordedLimitedSettings"]:
            continue
        if row.get("direction") not in {"FORWARD", "REVERSE"} or not finite(row["metrics"].get("area")) or row["metrics"]["area"] <= 0:
            continue
        key = (row["experimentCode"], row.get("runAlias"), row.get("group"), row.get("instrumentAlias"),
               row.get("direction"), row["metrics"]["area"], protocol["exploratorySettingsHash"], row["periodCohort"])
        grouped[key].append(row | {"exploratoryProtocol": protocol})
        # Identical vectors under changed source IDs/timestamps are a warning,
        # not proof of duplicate ingestion or independent measurement.
        repeated_key = digest({"experiment": row["experimentCode"], "sample": row["sampleAlias"],
            "run": row.get("runAlias"), "group": row.get("group"), "instrument": row.get("instrumentAlias"),
            "direction": row.get("direction"), "protocol": protocol["exploratorySettingsHash"], "metrics": row["metrics"]})
        repeated[repeated_key].append(row)
    output = []
    for key, scans in sorted(grouped.items(), key=lambda item: canonical(item[0])):
        output.append({"exploratoryStratumId": "exploratory-" + digest(key)[:24],
            "experimentCode": key[0], "runAlias": key[1], "group": key[2], "instrumentAlias": key[3],
            "direction": key[4], "area": key[5], "periodCohort": key[7],
            "exploratoryProtocol": scans[0]["exploratoryProtocol"] | {"originalFullSettingsHashes": sorted({digest(r.get("settings")) for r in scans})},
            "sourceStratumIds": sorted({row["strictStratumId"] for row in scans}),
            "recordedConditionSignatures": sorted({row["conditionEvidence"]["conditionSignature"] for row in scans}),
            "conditionIssues": sorted({issue for row in scans for issue in row["conditionEvidence"]["issues"]}),
            "comparisonStatus": "EXPLORATORY_NOT_VERIFIED_TREATMENT_OR_PROTOCOL_EQUIVALENCE",
            "inferenceOutcomes": inference_outcomes(scans),
            "aggregationScope": "Physical-sample medians within this experiment/run/group/instrument/direction/area/limited-recorded-settings/time cohort; unknown actual and unrecorded test conditions remain unknown"} | sample_summary(scans))
    matching, contrasts = defaultdict(list), []
    for stratum in output:
        if not stratum["inferenceOutcomes"]["nSamples"]:
            continue
        key = (stratum["experimentCode"], stratum["runAlias"], stratum["instrumentAlias"], stratum["direction"], stratum["area"],
               stratum["exploratoryProtocol"]["exploratorySettingsHash"], stratum["periodCohort"])
        matching[key].append(stratum)
    for strata in matching.values():
        for first_index, first in enumerate(strata):
            for second in strata[first_index + 1:]:
                if first["group"] == second["group"]:
                    continue
                first_samples = {s["sampleAlias"] for s in first["inferenceOutcomes"]["sampleOutcomes"]}
                second_samples = {s["sampleAlias"] for s in second["inferenceOutcomes"]["sampleOutcomes"]}
                contrasts.append({"firstStratumId": first["exploratoryStratumId"], "secondStratumId": second["exploratoryStratumId"],
                    "experimentCode": first["experimentCode"], "groups": [first["group"], second["group"]],
                    "secondMinusFirstPceMedianPercentagePoints": second["inferenceOutcomes"]["metrics"]["pce"]["median"] - first["inferenceOutcomes"]["metrics"]["pce"]["median"],
                    "sharedPhysicalSamples": len(first_samples & second_samples),
                    "comparisonStatus": "EXPLORATORY_WITHIN_EXPERIMENT_LIMITED_PROTOCOL",
                    "caution": "Group labels do not prove matching treatment or manufacture. Small device samples, missing actual/test conditions and unknown independent batches prevent causal effects or a validated ranking."})
    replays = []
    for values in repeated.values():
        measured_times = {row.get("measuredAt") for row in values if row.get("measuredAt")}
        cohorts = {row["periodCohort"] for row in values}
        if len(values) > 1 and len(measured_times) > 1:
            replays.append({"experimentCode": values[0]["experimentCode"], "sampleAlias": values[0]["sampleAlias"],
                "measurementAliases": sorted(row["evidenceIdentifier"] for row in values), "nSourceRows": len(values),
                "measuredAtValues": sorted(measured_times), "periodCohorts": sorted(cohorts),
                "crossesCurrentAndHistoricalPeriod": {"CURRENT_WEEK_MEASURED", "HISTORY_MEASURED"}.issubset(cohorts),
                "status": "IDENTICAL_RECORDED_METRIC_VECTOR_DIFFERENT_SOURCE_OR_TIMESTAMPS_REQUIRES_LINEAGE_REVIEW",
                "interpretation": "Retained as source evidence; neither independent repeat nor proven duplicate. Check original trace/upload lineage before claiming new performance evidence."})
    return output, contrasts, replays


def string_list(value, field):
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x.strip() for x in value):
        raise ValueError(field + " requires nonempty identifiers")
    if len(value) != len(set(value)):
        raise ValueError(field + " contains repeated identifiers")
    return value


def validate_entry(entry):
    required = {"entryId", "type", "projectAlias", "statement", "owner", "status", "sourceReportIds", "evidenceIdentifiers", "revision", "history"}
    if set(entry) != required:
        raise ValueError("Ledger entry fields must match the private versioned contract")
    if entry["type"] not in LEDGER_TYPES or entry["status"] not in LEDGER_STATUSES:
        raise ValueError("Invalid ledger type or status")
    if not all(isinstance(entry[key], str) and entry[key].strip() for key in ("entryId", "projectAlias", "statement")):
        raise ValueError("Ledger identity, project and statement required")
    if entry["owner"] is not None and not (isinstance(entry["owner"], str) and entry["owner"].strip()):
        raise ValueError("Owner must be a source-bound identity or null")
    string_list(entry["sourceReportIds"], "sourceReportIds")
    string_list(entry["evidenceIdentifiers"], "evidenceIdentifiers")
    if not isinstance(entry["revision"], int) or isinstance(entry["revision"], bool) or entry["revision"] < 1:
        raise ValueError("Positive ledger revision required")
    if not isinstance(entry["history"], list) or len(entry["history"]) != entry["revision"]:
        raise ValueError("Append-only history must contain every revision")
    for expected, item in enumerate(entry["history"], 1):
        allowed_history = {"revision", "statement", "owner", "status", "sourceReportIds", "evidenceIdentifiers", "reviewedBy", "reviewedAt", "decisionNote", "supersedesEntryId"}
        if set(item) != allowed_history:
            raise ValueError("Historical revisions must match the private ledger contract")
        if item.get("revision") != expected:
            raise ValueError("Noncontiguous ledger revision history")
        timestamp(item.get("reviewedAt"))
        if not text(item.get("reviewedBy")) or not text(item.get("decisionNote")):
            raise ValueError("Every revision needs explicit reviewer and decision note")
        string_list(item.get("sourceReportIds"), "history sourceReportIds")
        string_list(item.get("evidenceIdentifiers"), "history evidenceIdentifiers")
        if item.get("status") not in LEDGER_STATUSES:
            raise ValueError("Invalid historical status")
    latest = entry["history"][-1]
    for key in ("status", "owner", "statement", "sourceReportIds", "evidenceIdentifiers"):
        if latest.get(key) != entry[key]:
            raise ValueError("Entry must match its latest immutable revision")
    return entry


def update_ledger(prior_ledgers=None, reviewed_updates=None):
    """Only an explicit source-bound reviewed event can change a decision."""
    entries = {}
    for document in prior_ledgers or []:
        if document.get("schemaVersion") != 1:
            raise ValueError("Unsupported ledger schema")
        for candidate in document.get("ledgerEntries", []):
            entry = validate_entry(copy.deepcopy(candidate))
            old = entries.get(entry["entryId"])
            if old:
                short, long = (old, entry) if old["revision"] <= entry["revision"] else (entry, old)
                if long["history"][:short["revision"]] != short["history"] or old["type"] != entry["type"] or old["projectAlias"] != entry["projectAlias"]:
                    raise ValueError("Conflicting ledger histories; do not overwrite")
                entry = long
            entries[entry["entryId"]] = entry
    allowed = {"entryId", "expectedRevision", "type", "projectAlias", "statement", "owner", "status", "sourceReportIds",
               "evidenceIdentifiers", "reviewedBy", "reviewedAt", "decisionNote", "supersedesEntryId"}
    for update in reviewed_updates or []:
        if not isinstance(update, dict) or set(update) - allowed:
            raise ValueError("Unsupported reviewed-update fields")
        entry_id = update.get("entryId")
        if not text(entry_id):
            raise ValueError("Stable entryId required")
        old = entries.get(entry_id)
        expected = update.get("expectedRevision")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected != (old["revision"] if old else 0):
            raise ValueError("Ledger revision conflict")
        timestamp(update.get("reviewedAt"))
        if not text(update.get("reviewedBy")) or not text(update.get("decisionNote")):
            raise ValueError("Explicit reviewer and decision note required")
        string_list(update.get("sourceReportIds"), "sourceReportIds")
        string_list(update.get("evidenceIdentifiers"), "evidenceIdentifiers")
        if old and (("projectAlias" in update and update["projectAlias"] != old["projectAlias"]) or ("type" in update and update["type"] != old["type"])):
            raise ValueError("Ledger project/type identity is immutable")
        status = update.get("status", old["status"] if old else "proposed")
        if not old and status not in {"proposed", "not-evaluated"}:
            raise ValueError("Create a proposal before recording an evaluated outcome")
        supersedes = update.get("supersedesEntryId")
        if supersedes and (supersedes not in entries or entries[supersedes]["projectAlias"] != update.get("projectAlias", old["projectAlias"] if old else None) or supersedes == entry_id):
            raise ValueError("Superseded entry must exist in the same project")
        entry = {"entryId": entry_id, "type": update.get("type", old["type"] if old else None),
                 "projectAlias": update.get("projectAlias", old["projectAlias"] if old else None),
                 "statement": update.get("statement", old["statement"] if old else None),
                 "owner": update.get("owner", old["owner"] if old else None), "status": status,
                 "sourceReportIds": update["sourceReportIds"], "evidenceIdentifiers": update["evidenceIdentifiers"],
                 "revision": expected + 1, "history": copy.deepcopy(old["history"]) if old else []}
        revision = {key: copy.deepcopy(entry[key]) for key in ("revision", "statement", "owner", "status", "sourceReportIds", "evidenceIdentifiers")}
        revision |= {"reviewedBy": update["reviewedBy"], "reviewedAt": update["reviewedAt"], "decisionNote": update["decisionNote"],
                     "supersedesEntryId": supersedes}
        entry["history"].append(revision)
        entries[entry_id] = validate_entry(entry)
    return sorted(entries.values(), key=lambda e: (e["projectAlias"], e["entryId"]))


def analyze(snapshot, prior_ledgers=None, reviewed_updates=None, previous_snapshots=None):
    if snapshot.get("truncated") is True or snapshot.get("readOnly") is False:
        raise ValueError("Incomplete or mutable snapshot is not valid analysis evidence")
    primary_evidence = shared_app_evidence.dossier_primary_evidence(snapshot)
    end = timestamp(snapshot["windowEnd"])
    context = timestamp(snapshot.get("contextStart", snapshot["windowStart"]))
    period = timestamp(snapshot.get("periodStart", (end - dt.timedelta(days=7)).isoformat()))
    history = timestamp(snapshot.get("historyStart", (end - dt.timedelta(days=90)).isoformat()))
    snapshot_at = timestamp(snapshot.get("snapshotAt", snapshot.get("checkedAt")))
    if not history <= context <= period < end <= snapshot_at:
        raise ValueError("Require ordered history/context/period/end and a fresh frozen snapshot")
    experiments = {}
    for experiment in snapshot.get("experimentSummaries", []):
        if experiment["code"] in experiments:
            raise ValueError("Duplicate experiment code in snapshot")
        experiments[experiment["code"]] = experiment
    rows, dedup = unique_measurements(snapshot)
    previous_aliases, previous_row_count, previous_times = set(), 0, []
    for previous in previous_snapshots or []:
        prior_at = timestamp(previous.get("snapshotAt", previous.get("checkedAt")))
        if prior_at >= snapshot_at:
            raise ValueError("Previous snapshot must precede current snapshot")
        previous_times.append(prior_at)
        previous_rows = previous.get("sampleMeasurements", []) + previous.get("historicalSampleMeasurements", [])
        previous_row_count += len(previous_rows)
        previous_aliases.update(r.get("measurementAlias") for r in previous_rows if r.get("measurementAlias"))
    previous_complete = bool(previous_snapshots) and all(all(r.get("measurementAlias") for r in previous.get("sampleMeasurements", []) + previous.get("historicalSampleMeasurements", [])) for previous in previous_snapshots)
    previous_at = max(previous_times) if previous_times else None
    projects, grouped, exclusions = {}, defaultdict(list), Counter()
    project_scan_rows = defaultdict(list)
    def empty_project(metadata, key):
        return metadata | {"projectKey": key, "experiments": [], "strata": [],
            "receivedDuringPeriod": 0, "newMeasuredEvidenceScans": 0, "receivedOlderMeasurementsDuringPeriod": 0,
            "receivedUndatedMeasurementsDuringPeriod": 0, "newSourceAliasesSincePriorSnapshots": 0,
            "receivedSincePreviousSnapshot": 0 if previous_at else None,
            "receivedOlderMeasurementsSincePreviousSnapshot": 0 if previous_at else None,
            "receivedUndatedMeasurementsSincePreviousSnapshot": 0 if previous_at else None,
            "conditionIssues": Counter(), "unverifiedSummaryEvidence": [], "excludedMeasurementInventory": []}
    for item in snapshot.get("projectInventory", []):
        alias = item.get("projectAlias")
        if not alias and not (item.get("assigned") is False and item.get("label") == "UNASSIGNED"):
            raise ValueError("Canonical project inventory needs stable project aliases")
        projects[alias or "UNASSIGNED"] = empty_project({"projectAlias": alias, "projectName": item.get("name") or item.get("projectName"),
            "projectCode": item.get("code") or item.get("projectCode"), "assigned": bool(alias),
            "projectIdentityBasis": "CANONICAL_PROJECT_RELATION" if alias else "UNASSIGNED_REVIEW_BUCKET",
            "inventoryCounts": {"realExperimentCount": item.get("realExperimentCount"), "contextCount": item.get("contextCount")},
            "active": item.get("active")}, alias or "UNASSIGNED")
    for experiment in experiments.values():
        key = project_key(experiment)
        if key not in projects:
            projects[key] = empty_project(project_metadata(experiment), key)
        projects[key]["experiments"].append({"experimentCode": experiment["code"], "title": experiment.get("title"),
            "status": experiment.get("status"), "qualityReview": bool(experiment.get("qualityReview")),
            "createdDuringPeriod": in_interval(experiment.get("createdAt"), period, end),
            "updatedDuringPeriod": in_interval(experiment.get("updatedAt"), period, end),
            "observation": experiment.get("observation") or "", "problem": experiment.get("problem") or "",
            "hypothesis": experiment.get("hypothesis") or "", "conclusion": experiment.get("conclusion") or "",
            "recordedDesignIntent": recorded_design_intent(experiment),
            "recordedSampleArmInventory": [{"sampleAlias": sample.get("sampleAlias"), "sampleCode": sample.get("code"),
                "currentVariationGroup": sample.get("variationGroup"), "recordedNote": sample.get("note"),
                "excludedByCurrentErrorExtraFlag": sample.get("variationGroup") in {"ERROR", "EXTRA"},
                "currentFlagBasis": "CURRENT_AT_SNAPSHOT_NOT_ORIGINAL_TREATMENT_ASSIGNMENT",
                "originalTreatmentAndYieldDenominator": "UNVERIFIED"} for sample in experiment.get("samples", [])],
            "recordedNarrativeInterpretation": "CURRENT_RECORDED_NARRATIVE_NOT_A_VERIFIED_RESULT",
            "independentBatchStatus": "UNVERIFIED"})
        for sample in experiment.get("samples", []):
            for result in sample.get("results", []):
                if result.get("sourceMeasurementAlias"):
                    continue  # Derived result must not count the same scan twice.
                projects[key]["unverifiedSummaryEvidence"].append({"experimentCode": experiment["code"],
                    "sampleAlias": sample.get("sampleAlias"), "resultAlias": result.get("resultAlias"),
                    "source": result.get("source"), "metricPolicy": result.get("metricPolicy"), "runAlias": result.get("runAlias"),
                    "capturedAt": result.get("capturedAt"), "metrics": result.get("metrics"),
                    "evidenceTier": "MANUAL_RESULT" if result.get("source") == "MANUAL" else "UNLINKED_IMPORTED_SUMMARY",
                    "comparisonEligible": False, "reason": "No stable source measurement link; BEST-only summaries are not full scan distributions or independent batches."})
    for evidence_id, row in rows:
        experiment = experiments.get(row.get("experimentCode"))
        reasons = []
        if not experiment:
            reasons.append("outside_eligible_experiment_context")
        elif experiment.get("qualityReview") or text(experiment.get("title")).lower().startswith("[test]"):
            reasons.append("quarantined_experiment")
        if row.get("group") in {"ERROR", "EXTRA"}:
            reasons.append("current_error_extra_sample")
        if row.get("condition", "LIGHT") != "LIGHT":
            reasons.append("non_light_scan")
        if not row.get("sampleAlias"):
            reasons.append("missing_physical_sample_identity")
        metrics = row.get("metrics") or {}
        if not finite(metrics.get("pce")) or not 0 <= metrics["pce"] <= 50:
            reasons.append("pce_outside_descriptive_cohort")
        if experiment and row.get("projectAlias") and row["projectAlias"] != project_metadata(experiment)["projectAlias"]:
            reasons.append("conflicting_project_link")
        if reasons:
            exclusions.update(reasons)
            if experiment:
                projects[project_key(experiment)]["excludedMeasurementInventory"].append({
                    "experimentCode": experiment["code"], "measurementAlias": evidence_id,
                    "sampleAlias": row.get("sampleAlias"), "runAlias": row.get("runAlias"),
                    "group": row.get("group"), "measuredAt": row.get("measuredAt"), "receivedAt": row.get("receivedAt"),
                    "exclusionReasons": reasons, "performanceInferenceEligible": False,
                    "interpretation": "Retained source/arm evidence, excluded from performance summaries; not an inferred zero-performance device or production-yield denominator."})
            continue
        key = project_key(experiment)
        measured, received = row.get("measuredAt"), row.get("receivedAt")
        measured_period = in_interval(measured, period, end)
        receipt_period = in_interval(received, period, end)
        if measured:
            if not in_interval(measured, history, end):
                exclusions["measurement_outside_frozen_history"] += 1
                projects[key]["excludedMeasurementInventory"].append({"experimentCode": experiment["code"],
                    "measurementAlias": evidence_id, "sampleAlias": row.get("sampleAlias"), "runAlias": row.get("runAlias"),
                    "group": row.get("group"), "measuredAt": measured, "receivedAt": received,
                    "exclusionReasons": ["measurement_outside_frozen_history"], "performanceInferenceEligible": False})
                continue
            cohort = "CURRENT_WEEK_MEASURED" if measured_period else "HISTORY_MEASURED"
        else:
            if not in_interval(received, history, end):
                exclusions["undated_receipt_outside_frozen_history"] += 1
                projects[key]["excludedMeasurementInventory"].append({"experimentCode": experiment["code"],
                    "measurementAlias": evidence_id, "sampleAlias": row.get("sampleAlias"), "runAlias": row.get("runAlias"),
                    "group": row.get("group"), "measuredAt": measured, "receivedAt": received,
                    "exclusionReasons": ["undated_receipt_outside_frozen_history"], "performanceInferenceEligible": False})
                continue
            cohort = "UNDATED_RECEIPT_CURRENT" if receipt_period else "UNDATED_RECEIPT_HISTORY"
        project = projects[key]
        project["receivedDuringPeriod"] += receipt_period
        project["newMeasuredEvidenceScans"] += measured_period
        project["receivedOlderMeasurementsDuringPeriod"] += receipt_period and bool(measured) and not measured_period
        project["receivedUndatedMeasurementsDuringPeriod"] += receipt_period and not measured
        project["newSourceAliasesSincePriorSnapshots"] += bool(previous_complete and row.get("measurementAlias") and row["measurementAlias"] not in previous_aliases)
        if previous_at:
            received_since = in_interval(received, previous_at, snapshot_at)
            project["receivedSincePreviousSnapshot"] += received_since
            project["receivedOlderMeasurementsSincePreviousSnapshot"] += received_since and bool(measured) and in_interval(measured, history, previous_at)
            project["receivedUndatedMeasurementsSincePreviousSnapshot"] += received_since and not measured
        tier = "SOURCE_LINKED_INSTRUMENT_SCAN" if row.get("measurementAlias") and row.get("sourceLinked") is True else "UNVERIFIED_SOURCE_SCAN"
        protocol_row = row | {"metricUnits": row.get("metricUnits") or snapshot.get("metricUnits")}
        condition, protocol = condition_signature(experiment, row), protocol_signature(protocol_row)
        project["conditionIssues"].update(condition["issues"])
        # Missing run/protocol/area are not identical observations. Isolate them
        # rather than grouping two nulls and pretending they establish equality.
        missing_separation = any(issue in protocol["issues"] for issue in ("missing_run_link", "unverified_or_wrong_experiment_run_link", "missing_measurement_settings", "missing_or_invalid_area", "missing_or_unknown_scan_direction"))
        stratum_key = (key, experiment["code"], row.get("runAlias"), row.get("group"), row.get("direction"),
                       protocol["protocolSignature"], condition["conditionSignature"], tier, cohort,
                       evidence_id if missing_separation else None)
        row["metricUnits"] = protocol_row.get("metricUnits")
        row["metricDiagnostics"] = metric_diagnostics(row)
        row["evidenceIdentifier"] = evidence_id
        row["conditionEvidence"], row["protocolEvidence"] = condition, protocol
        row["evidenceTier"], row["periodCohort"] = tier, cohort
        row["strictStratumId"] = "stratum-" + digest(stratum_key)[:24]
        grouped[stratum_key].append(row)
        project_scan_rows[key].append(row)
    for key, scans in sorted(grouped.items(), key=lambda item: canonical(item[0])):
        row = scans[0]
        stratum = {"stratumId": "stratum-" + digest(key)[:24], "experimentCode": key[1], "runAlias": key[2],
                   "group": key[3], "direction": key[4], "evidenceTier": key[7], "periodCohort": key[8],
                   "conditionEvidence": row["conditionEvidence"], "protocolEvidence": row["protocolEvidence"],
                   "comparabilityIssues": sorted(set(row["conditionEvidence"]["issues"] + row["protocolEvidence"]["issues"])),
                   "inferenceOutcomes": inference_outcomes(scans),
                   "firstMeasuredAt": min((r["measuredAt"] for r in scans if r.get("measuredAt")), default=None, key=timestamp),
                   "lastMeasuredAt": max((r["measuredAt"] for r in scans if r.get("measuredAt")), default=None, key=timestamp)} | sample_summary(scans)
        projects[key[0]]["strata"].append(stratum)
    ledger_entries = update_ledger(prior_ledgers, reviewed_updates)
    for project in projects.values():
        project["conditionIssues"] = dict(sorted(project["conditionIssues"].items()))
        project["conditionIssueCountsBasis"] = "ELIGIBLE_SCAN_ROWS; overlapping issues and repeated scans are not independent samples"
        project["experiments"].sort(key=lambda x: x["experimentCode"])
        project["comparisons"] = comparison_pairs(project["strata"]) if project["assigned"] else []
        exploratory, contrasts, replays = exploratory_strata_and_contrasts(project_scan_rows[project["projectKey"]])
        project["exploratoryStrata"], project["exploratoryGroupContrasts"], project["identicalMetricVectorLineageWarnings"] = exploratory, contrasts, replays
        scans = project_scan_rows[project["projectKey"]]
        project["periodPerformance"] = period_performance(scans, period, end, history)
        project["excludedArmCoverage"] = "CURRENT_COLLECTED_SAMPLE_FLAGS_AND_AVAILABLE_SCAN_ROWS_ONLY; collector-filtered scans are not reconstructed, current ERROR/EXTRA flags may obscure original assignment, no initial-allocation or yield denominator is inferred"
        project["metricQualityInventory"] = [{"experimentCode": row["experimentCode"], "measurementAlias": row["evidenceIdentifier"],
            "sampleAlias": row["sampleAlias"], "runAlias": row.get("runAlias"), "periodCohort": row["periodCohort"],
            "measuredAt": row.get("measuredAt"), "receivedAt": row.get("receivedAt"), "metricDiagnostics": row["metricDiagnostics"],
            "recordedMetrics": row["metrics"], "metricUnits": row.get("metricUnits")}
            for row in scans if row["metricDiagnostics"]["internallyInconsistentMetricReasons"] or row["metricDiagnostics"]["traceQualityFlags"] or row["metricDiagnostics"]["missingMetricKeys"]]
        project["performanceInferenceCounts"] = {"originalDescriptiveEligibleSourceRows": len(scans),
            "internallyInconsistentRowsExcludedFromInference": sum(not row["metricDiagnostics"]["performanceInferenceEligible"] for row in scans),
            "currentWeekDescriptiveEligibleSourceRows": sum(row["periodCohort"] == "CURRENT_WEEK_MEASURED" for row in scans),
            "currentWeekRowsEligibleForInference": sum(row["periodCohort"] == "CURRENT_WEEK_MEASURED" and row["metricDiagnostics"]["performanceInferenceEligible"] for row in scans),
            "traceRowsWithFewerThanTwoRecordedPoints": sum(bool(row["metricDiagnostics"]["traceQualityFlags"]) for row in scans)}
        project["comparisonScopeStatus"] = "CANONICAL_PROJECT_ONLY" if project["assigned"] else "PROJECT_UNASSIGNED_CROSS_EXPERIMENT_MATCHING_DISABLED"
        project["ledgerEntries"] = [entry for entry in ledger_entries if entry["projectAlias"] == project["projectKey"]]
        aliases = {alias for stratum in project["strata"] for alias in stratum["conditionEvidence"]["materialAliases"]}
        times = [stratum["firstMeasuredAt"] for stratum in project["strata"] if stratum["firstMeasuredAt"]]
        project["chemistryEvidenceCoverage"] = chemistry_evidence(snapshot, aliases, times)
        project["performanceStatus"] = "NEW_MEASURED_EVIDENCE" if project["newMeasuredEvidenceScans"] else "NO_NEW_MEASURED_EVIDENCE"
        project["noveltyStatus"] = "CHECKED_AGAINST_PRIOR_SOURCE_ALIASES_WITHIN_THEIR_WINDOWS" if previous_complete else "UNVERIFIED_ALIAS_BASELINE_RECEIPT_TIME_ONLY" if previous_snapshots else "PRIOR_SNAPSHOT_COMPARISON_NOT_AVAILABLE"
        if not previous_complete:
            project["newSourceAliasesSincePriorSnapshots"] = None
        project["technicalProgressAssessment"] = "REQUIRES_REVIEWED_INTERPRETATION_OF_SOURCE_EVIDENCE"
    return {"schemaVersion": 1, "classification": PRIVATE_CLASSIFICATION, "readOnlyAnalysis": True,
            "snapshotAt": snapshot_at.isoformat(), "periodStart": period.isoformat(), "contextStart": context.isoformat(),
            "historyStart": history.isoformat(), "windowEnd": end.isoformat(), "deduplication": dedup,
            "previousSnapshotBaseline": {"latestSnapshotAt": previous_at.isoformat() if previous_at else None,
                "sourceAliasCoverageComplete": previous_complete, "previousInputRows": previous_row_count,
                "limitation": "Alias novelty is limited to prior collected windows; new receipt timestamps do not establish newly manufactured devices."},
            "exclusionReasonCounts": dict(sorted(exclusions.items())), "projects": sorted(projects.values(), key=lambda p: p["projectKey"]),
            "projectCoverage": {"experimentContexts": len(experiments),
                "assignedExperimentContexts": sum(project_metadata(e)["assigned"] for e in experiments.values()),
                "unassignedExperimentContexts": sum(not project_metadata(e)["assigned"] for e in experiments.values()),
                "canonicalProjectsWithoutContextExperiments": sum(p["assigned"] and not p["experiments"] for p in projects.values())},
            "ledgerEntries": ledger_entries,
            "primaryExperimentEvidence": primary_evidence,
            "method": "Sample medians within separate experiment/run/group/direction/recorded protocol/condition/time strata; linear-interpolated quartiles and sample dispersion. No causal model; no automatic hypothesis decision or batch verification.",
            "scopeCautions": ["Current experiment, group, recipe and material metadata are not reconstructed historical facts.",
                              "Receipt-only or delayed ingestion is distinct from current-week measured performance.",
                              "Independent manufacturing batches require explicit source-bound provenance.",
                              "Raw molecular definitions and diagrams are omitted; this dossier remains private because it contains internal evidence references.",
                              "Quality counters can overlap and are not a disjoint rejection flow."]}


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--prior-ledger", type=Path, action="append", default=[])
    parser.add_argument("--reviewed-updates", type=Path)
    parser.add_argument("--previous-snapshot", type=Path, action="append", default=[])
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    updates = read(args.reviewed_updates) if args.reviewed_updates else []
    if not isinstance(updates, list):
        raise ValueError("Reviewed updates must be a list of explicit versioned events")
    result = analyze(read(args.snapshot), [read(p) for p in args.prior_ledger], updates, [read(p) for p in args.previous_snapshot])
    private_json(args.output, result)
    print(json.dumps({"saved": str(args.output), "projectContexts": len(result["projects"]), "ledgerEntries": len(result["ledgerEntries"])}))


if __name__ == "__main__":
    main()
