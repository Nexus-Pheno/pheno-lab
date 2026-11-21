#!/usr/bin/env python3
"""Synthetic R&D dossier/continuity regressions; no production data or writes."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("analyze_rd_snapshot", Path(__file__).with_name("analyze_rd_snapshot.py"))
rd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rd)


def scan(alias, sample="s1", pce=10, **overrides):
    return {"measurementAlias": alias, "experimentCode": "E1", "projectAlias": "P1", "sampleAlias": sample,
            "runAlias": "R1", "group": "A", "direction": "REVERSE", "condition": "LIGHT", "sourceLinked": True,
            "metrics": {"pce": pce, "voc": 1, "jsc": 20, "ff": 80, "area": 1},
            "settings": {"scanSpeed": 100, "areaDefinition": "active"},
            "metricUnits": {"pce": "%", "voc": "V", "jsc": "mA/cm2", "ff": "%"},
            "measuredAt": "2026-10-12T00:00:00Z", "receivedAt": "2026-10-12T01:00:00Z", "timeBasis": "measured"} | overrides


def experiment(code="E1", project="P1", samples=("s1", "s2"), runs=("R1", "R2"), **overrides):
    return {"code": code, "projectAlias": project, "projectName": "Synthetic project", "projectCode": None,
            "title": "Synthetic material comparison", "hypothesis": "Matched recipe improves film coverage.",
            "conclusion": "Pending confirmation", "status": "IN_PROGRESS", "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-12T02:00:00Z", "steps": [{"position": 0, "name": "Coat", "layer": "PVK",
                "process": {"name": "Blade coat"}, "recipe": {"recipeAlias": "recipe1", "name": "Synthetic recipe",
                    "payload": {"components": [{"material": "public precursor", "amount": "1 mol"}],
                                "solvents": "public solvent", "concentration": "1 M"}},
                "materials": [{"amount": "1 mg/mL", "material": {"materialAlias": "mat1", "name": "Synthetic SAM", "category": "SAM"}}],
                "parameters": [{"name": "speed", "value": "10", "unit": "mm/s", "source": "process",
                                "variations": [{"variationGroup": "B", "value": "20"}]}],
                "executions": [{"sampleAlias": sample, "runAlias": run, "actuals": {"speed": "10"},
                                "capturedAt": "2026-09-01T00:00:00Z", "materialSelections": []}
                               for sample in samples for run in runs]}], "samples": []} | overrides


def snapshot(rows=(), experiments=None, historical=()):
    return {"schemaVersion": 1, "snapshotAt": "2026-10-13T01:00:00Z", "windowStart": "2026-09-13T00:00:00Z",
            "contextStart": "2026-09-13T00:00:00Z", "periodStart": "2026-10-06T00:00:00Z",
            "historyStart": "2026-07-15T00:00:00Z", "windowEnd": "2026-10-13T00:00:00Z",
            "sampleMeasurements": list(rows), "historicalSampleMeasurements": list(historical),
            "experimentSummaries": [experiment()] if experiments is None else experiments,
            "chemistryAccessAvailable": True, "privateChemistryDefinitions": []}


def proposal(**changes):
    return {"entryId": "rd-proposal-1", "expectedRevision": 0, "type": "recommendation", "projectAlias": "P1",
            "statement": "Confirm the matched SAM/recipe comparison in independent batches.", "owner": None,
            "status": "proposed", "sourceReportIds": ["synthetic-source-report-v1"],
            "evidenceIdentifiers": ["report:synthetic-source-report-v1:proposal-1"],
            "reviewedBy": "source-reviewer", "reviewedAt": "2026-10-13T01:00:00Z",
            "decisionNote": "Imported reviewed proposal; no execution evidence."} | changes


class DossierTests(unittest.TestCase):
    def test_sample_medians_do_not_treat_repeated_scans_as_devices(self):
        rows = [scan("m" + str(i), pce=10) for i in range(10)] + [scan("other", sample="s2", pce=20)]
        stratum = rd.analyze(snapshot(rows))["projects"][0]["strata"][0]
        self.assertEqual(stratum["nScans"], 11)
        self.assertEqual(stratum["nSamples"], 2)
        self.assertEqual(stratum["metrics"]["pce"]["median"], 15)
        self.assertEqual(stratum["metrics"]["pce"]["iqr"], 5)
        self.assertIsNone(stratum["independentBatchCount"])
        self.assertEqual(stratum["verifiedIndependentManufacturingBatches"], 0)

    def test_duplicate_aliases_across_windows_are_not_replication(self):
        row = scan("m1")
        output = rd.analyze(snapshot([row], historical=[dict(row, isPeriodEvidence=False)]))
        self.assertEqual(output["deduplication"]["duplicateSourceRowsRemoved"], 1)
        self.assertEqual(output["projects"][0]["strata"][0]["nScans"], 1)

    def test_conflicting_alias_is_quarantined_not_arbitrarily_selected(self):
        output = rd.analyze(snapshot([scan("m1"), scan("m1", pce=20)]))
        self.assertEqual(output["deduplication"]["conflictingSourceAliases"], ["m1"])
        self.assertEqual(output["projects"][0]["strata"], [])

    def test_protocol_run_direction_area_and_variations_stay_separate(self):
        rows = [scan("a"), scan("b", runAlias="R2"), scan("c", direction="FORWARD"),
                scan("d", metrics={"pce": 10, "area": 2}), scan("e", settings={"scanSpeed": 200}),
                scan("f", group="B")]
        output = rd.analyze(snapshot(rows))["projects"][0]
        self.assertEqual(len(output["strata"]), 6)
        groups = {s["group"]: s["conditionEvidence"]["plannedSignature"] for s in output["strata"]}
        self.assertNotEqual(groups["A"], groups["B"])

    def test_missing_protocol_values_are_not_equal(self):
        rows = [scan("a", settings=None), scan("b", settings=None)]
        strata = rd.analyze(snapshot(rows))["projects"][0]["strata"]
        self.assertEqual(len(strata), 2)
        self.assertTrue(all(s["nScans"] == 1 for s in strata))

    def test_unverified_run_links_and_area_definition_are_not_verified_protocols(self):
        output = rd.analyze(snapshot([scan("a", runLinkStatus="UNVERIFIED", areaDefinition="UNVERIFIED"),
                                      scan("b", runLinkStatus="UNVERIFIED", areaDefinition="UNVERIFIED")]))
        strata = output["projects"][0]["strata"]
        self.assertEqual(len(strata), 2)
        self.assertIn("unverified_area_definition", strata[0]["comparabilityIssues"])
        self.assertIn("unverified_or_wrong_experiment_run_link", strata[0]["comparabilityIssues"])

    def test_exact_collector_project_inventory_and_top_units_contract(self):
        data = snapshot([scan("a", metricUnits=None, areaDefinition="UNVERIFIED")])
        data["metricUnits"] = {"pce": "%", "voc": "V", "jsc": "mA/cm²", "ff": "%"}
        data["projectInventory"] = [{"projectAlias": "P1", "projectName": "Synthetic project", "realExperimentCount": 1, "contextCount": 1},
                                    {"projectAlias": None, "assigned": False, "label": "UNASSIGNED", "realExperimentCount": 0, "contextCount": 0}]
        projects = {p["projectKey"]: p for p in rd.analyze(data)["projects"]}
        self.assertEqual(projects["P1"]["inventoryCounts"]["realExperimentCount"], 1)
        self.assertEqual(projects["P1"]["strata"][0]["protocolEvidence"]["metricUnits"], data["metricUnits"])
        self.assertEqual(projects["UNASSIGNED"]["strata"], [])

    def test_supplementary_excludes_only_trace_identity_and_preserves_strict_hashes(self):
        rows = [scan("a", instrumentAlias="instrument1", settings={"traceName": "specimen-one", "points": 122, "note": "0", "signFlipped": True}),
                scan("b", sample="s2", pce=20, instrumentAlias="instrument1", settings={"traceName": "specimen-two", "points": 122, "note": "0", "signFlipped": True})]
        output = rd.analyze(snapshot(rows))["projects"][0]
        self.assertEqual(len(output["strata"]), 2)
        self.assertEqual(len(output["exploratoryStrata"]), 1)
        supplemental = output["exploratoryStrata"][0]
        self.assertEqual(supplemental["nSamples"], 2)
        self.assertEqual(supplemental["metrics"]["pce"]["median"], 15)
        self.assertEqual(len(supplemental["exploratoryProtocol"]["originalFullSettingsHashes"]), 2)
        self.assertEqual(supplemental["exploratoryProtocol"]["excludedIdentityKeys"], ["traceName"])
        self.assertIn("irradiance", supplemental["exploratoryProtocol"]["unrecordedProtocolFields"])
        self.assertIn("scanRate", supplemental["exploratoryProtocol"]["unrecordedProtocolFields"])
        self.assertIsNone(supplemental["independentBatchCount"])

    def test_supplementary_never_pools_changed_test_fields_instrument_area_or_run(self):
        base = {"traceName": "trace", "points": 122, "signFlipped": True, "note": "0"}
        rows = [scan("a", instrumentAlias="i1", settings=base), scan("b", instrumentAlias="i2", settings=base),
                scan("c", instrumentAlias="i1", settings=base | {"points": 112}),
                scan("d", instrumentAlias="i1", settings=base | {"note": "100"}),
                scan("e", instrumentAlias="i1", settings=base | {"signFlipped": False}),
                scan("f", instrumentAlias="i1", settings=base, runAlias="R2"),
                scan("g", instrumentAlias="i1", settings=base, metrics={"pce": 10, "area": 2}),
                scan("h", instrumentAlias="i1", settings=base, direction="FORWARD")]
        output = rd.analyze(snapshot(rows))["projects"][0]
        self.assertEqual(len(output["exploratoryStrata"]), 8)

    def test_supplementary_group_contrast_remains_exploratory_and_sample_first(self):
        base = {"points": 122, "signFlipped": True, "note": "0"}
        rows = [scan("a", instrumentAlias="i1", settings=base), scan("b", sample="s2", pce=20, group="B", instrumentAlias="i1", settings=base)]
        project = rd.analyze(snapshot(rows))["projects"][0]
        self.assertEqual(len(project["exploratoryGroupContrasts"]), 1)
        contrast = project["exploratoryGroupContrasts"][0]
        self.assertEqual(contrast["secondMinusFirstPceMedianPercentagePoints"], 10)
        self.assertEqual(contrast["comparisonStatus"], "EXPLORATORY_WITHIN_EXPERIMENT_LIMITED_PROTOCOL")

    def test_identical_vectors_with_different_dates_warn_without_claiming_duplicate_or_replication(self):
        rows = [scan("a", instrumentAlias="i1", settings={"points": 122}),
                scan("b", instrumentAlias="i1", settings={"points": 122}, measuredAt="2026-09-20T00:00:00Z")]
        project = rd.analyze(snapshot(rows))["projects"][0]
        warning = project["identicalMetricVectorLineageWarnings"][0]
        self.assertTrue(warning["crossesCurrentAndHistoricalPeriod"])
        self.assertEqual(warning["nSourceRows"], 2)
        self.assertEqual(sum(s["nScans"] for s in project["exploratoryStrata"]), 2)

    def test_internally_inconsistent_metrics_retained_but_excluded_from_inference(self):
        row = scan("bad", instrumentAlias="i1", settings={"points": 1}, metrics={"pce": 1.5, "voc": 0, "jsc": 0, "ff": 1e34, "area": 1})
        project = rd.analyze(snapshot([row]))["projects"][0]
        self.assertEqual(project["newMeasuredEvidenceScans"], 1)
        self.assertEqual(project["strata"][0]["nScans"], 1)
        self.assertEqual(project["strata"][0]["inferenceOutcomes"]["nScans"], 0)
        self.assertEqual(project["performanceInferenceCounts"]["currentWeekDescriptiveEligibleSourceRows"], 1)
        self.assertEqual(project["performanceInferenceCounts"]["currentWeekRowsEligibleForInference"], 0)
        self.assertEqual(project["metricQualityInventory"][0]["measurementAlias"], "bad")
        self.assertEqual(project["metricQualityInventory"][0]["recordedMetrics"]["ff"], 1e34)
        self.assertEqual(len(project["metricQualityInventory"][0]["metricDiagnostics"]["internallyInconsistentMetricReasons"]), 3)

    def test_unknown_or_missing_metrics_are_not_reconstructed_or_declared_inconsistent(self):
        diagnostic = rd.metric_diagnostics(scan("a", metrics={"pce": 10}, metricUnits={}))
        self.assertEqual(diagnostic["internallyInconsistentMetricReasons"], [])
        self.assertEqual(set(diagnostic["missingMetricKeys"]), {"voc", "jsc", "ff"})
        self.assertFalse(diagnostic["ffUnitVerifiedPercent"])
        self.assertTrue(diagnostic["performanceInferenceEligible"])

    def test_ff_validation_uses_recorded_percent_contract_only(self):
        for ff in (0, -1, 101):
            row = scan("a"); row["metrics"]["ff"] = ff
            self.assertIn("recorded_percent_ff_outside_0_to_100", rd.metric_diagnostics(row)["internallyInconsistentMetricReasons"])
        row = scan("a"); row["metrics"]["ff"] = 100
        self.assertEqual(rd.metric_diagnostics(row)["internallyInconsistentMetricReasons"], [])
        row["metrics"]["ff"] = 1000; row["metricUnits"] = {"ff": "unknown"}
        self.assertEqual(rd.metric_diagnostics(row)["internallyInconsistentMetricReasons"], [])

    def test_single_trace_point_flag_is_separate_from_metric_inconsistency_gate(self):
        diagnostic = rd.metric_diagnostics(scan("a", settings={"points": 1}))
        self.assertEqual(diagnostic["traceQualityFlags"], ["recorded_jv_trace_has_fewer_than_two_points"])
        self.assertTrue(diagnostic["performanceInferenceEligible"])
        self.assertEqual(rd.metric_diagnostics(scan("b", settings={}))['traceQualityFlags'], [])

    def test_project_boundaries_and_unassigned_bucket_are_explicit(self):
        experiments = [experiment(), experiment("E2", "P2"), experiment("E3", None), experiment("E4", None)]
        data = snapshot([scan("a"), scan("b", experimentCode="E2", projectAlias="P2"),
                         scan("c", experimentCode="E3", projectAlias=None), scan("d", experimentCode="E4", projectAlias=None)], experiments)
        data["projectInventory"] = [{"projectAlias": "P3", "name": "Empty real project", "active": True}]
        output = rd.analyze(data)
        projects = {p["projectKey"]: p for p in output["projects"]}
        self.assertEqual(set(projects), {"P1", "P2", "P3", "UNASSIGNED"})
        self.assertEqual(len(projects["UNASSIGNED"]["experiments"]), 2)
        self.assertEqual(projects["UNASSIGNED"]["comparisons"], [])
        self.assertEqual(projects["P3"]["performanceStatus"], "NO_NEW_MEASURED_EVIDENCE")
        self.assertEqual(output["projectCoverage"]["canonicalProjectsWithoutContextExperiments"], 1)

    def test_older_receipts_and_missing_measurement_time_do_not_enter_weekly_trend(self):
        rows = [scan("current"), scan("old", measuredAt="2026-09-20T00:00:00Z"), scan("undated", measuredAt=None, timeBasis="received")]
        project = rd.analyze(snapshot(rows))["projects"][0]
        self.assertEqual(project["newMeasuredEvidenceScans"], 1)
        self.assertEqual(project["receivedOlderMeasurementsDuringPeriod"], 1)
        self.assertEqual(project["receivedUndatedMeasurementsDuringPeriod"], 1)
        cohorts = {s["periodCohort"] for s in project["strata"]}
        self.assertEqual(cohorts, {"CURRENT_WEEK_MEASURED", "HISTORY_MEASURED", "UNDATED_RECEIPT_CURRENT"})
        self.assertEqual(len(project["comparisons"]), 1)
        self.assertEqual(project["comparisons"][0]["comparabilityStatus"], "UNVERIFIED_COMPARABILITY")
        self.assertEqual(project["comparisons"][0]["sharedPhysicalSamples"], 1)

    def test_legacy_previous_snapshot_supports_only_receipt_baseline(self):
        previous = snapshot([scan("m1")])
        previous["snapshotAt"] = "2026-10-11T02:00:00Z"
        previous["sampleMeasurements"][0].pop("measurementAlias")
        output = rd.analyze(snapshot([scan("m1")]), previous_snapshots=[previous])
        project = output["projects"][0]
        self.assertIsNone(project["newSourceAliasesSincePriorSnapshots"])
        self.assertEqual(project["receivedSincePreviousSnapshot"], 1)
        self.assertFalse(output["previousSnapshotBaseline"]["sourceAliasCoverageComplete"])

    def test_legacy_rows_remain_separate_and_cannot_be_claimed_source_linked(self):
        row = scan("a"); row.pop("measurementAlias")
        output = rd.analyze(snapshot([row]))
        self.assertEqual(output["deduplication"]["missingStableMeasurementAliasRows"], 1)
        self.assertEqual(output["projects"][0]["strata"][0]["evidenceTier"], "UNVERIFIED_SOURCE_SCAN")

    def test_missing_recipe_dose_or_actuals_prevents_treatment_equivalence(self):
        for missing in ("recipe", "dose", "unit", "actuals"):
            experiment_value = experiment()
            if missing == "recipe": experiment_value["steps"][0]["recipe"] = None
            if missing == "dose": experiment_value["steps"][0]["materials"][0]["amount"] = ""
            if missing == "unit": experiment_value["steps"][0]["materials"][0]["amount"] = "1"
            if missing == "actuals": experiment_value["steps"][0]["executions"] = []
            condition = rd.condition_signature(experiment_value, scan("a"))
            self.assertTrue(condition["issues"])
            self.assertFalse(condition["historicalProvenanceVerified"])
            self.assertFalse(condition["actualCaptureComplete"] if missing == "actuals" else condition["plannedIdentityComplete"])

    def test_same_group_labels_are_not_a_treatment_signature(self):
        e1, e2 = experiment(), experiment("E2")
        e2["steps"][0]["recipe"]["payload"]["concentration"] = "2 M"
        self.assertNotEqual(rd.condition_signature(e1, scan("a"))["plannedSignature"],
                            rd.condition_signature(e2, scan("b", experimentCode="E2"))["plannedSignature"])

    def test_best_summaries_remain_separate_and_linked_result_does_not_double_count(self):
        exp = experiment(samples=("s1",))
        exp["samples"] = [{"sampleAlias": "s1", "results": [
            {"resultAlias": "z1", "source": "INSTRUMENT", "metricPolicy": "BEST", "metrics": {"pce": 30}},
            {"resultAlias": "z2", "source": "INSTRUMENT", "metricPolicy": "BEST", "metrics": {"pce": 40}, "sourceMeasurementAlias": "m1"}]}]
        project = rd.analyze(snapshot([scan("m1")], [exp]))["projects"][0]
        self.assertEqual(project["strata"][0]["metrics"]["pce"]["median"], 10)
        self.assertEqual(len(project["unverifiedSummaryEvidence"]), 1)
        self.assertFalse(project["unverifiedSummaryEvidence"][0]["comparisonEligible"])

    def test_metric_denominators_and_dispersion_are_not_invented(self):
        rows = [scan("a"), scan("b", sample="s2", pce=20, metrics={"pce": 20, "voc": None, "ff": 80, "area": 1})]
        metrics = rd.analyze(snapshot(rows))["projects"][0]["strata"][0]["metrics"]
        self.assertEqual(metrics["pce"]["nSamples"], 2)
        self.assertEqual(metrics["voc"]["nSamples"], 1)
        self.assertIsNone(metrics["voc"]["sampleStandardDeviation"])
        self.assertEqual(metrics["ff"]["median"], 80)

    def test_explicit_batch_provenance_required_for_independent_count(self):
        row = scan("a", independentBatchEvidence={"independenceVerified": True, "manufacturingBatchAlias": "batch1",
                                                  "evidenceIdentifiers": ["reviewed:manufacture-record-1"]})
        result = rd.analyze(snapshot([row]))["projects"][0]["strata"][0]
        self.assertEqual(result["independentBatchCount"], 1)
        self.assertEqual(result["independentBatchStatus"], "EXPLICIT_PROVENANCE")

    def test_stale_chemistry_is_flagged_and_structures_are_not_in_dossier(self):
        data = snapshot([scan("a")])
        data["privateChemistryDefinitions"] = [{"materialAlias": "mat1", "name": "Synthetic SAM", "category": "SAM", "smiles": "C[C@H](O)N",
             "chemistry": {"canonicalSmiles": "private-canonical-graph", "inputSha256": "stale", "version": 2, "generatedAt": "2026-10-13T00:30:00Z"}}]
        result = rd.analyze(data)
        chemistry = result["projects"][0]["chemistryEvidenceCoverage"][0]
        self.assertEqual(chemistry["hashValidationStatus"], "MISMATCH")
        self.assertFalse(chemistry["currentValidatedDefinition"])
        self.assertTrue(chemistry["definitionPostdatesSomeMeasurements"])
        self.assertNotIn("C[C@H](O)N", json.dumps(result))
        self.assertNotIn("private-canonical-graph", json.dumps(result))
        data["privateChemistryDefinitions"][0]["chemistry"]["inputSha256"] = hashlib.sha256(b"C[C@H](O)N").hexdigest()
        valid = rd.analyze(data)["projects"][0]["chemistryEvidenceCoverage"][0]
        self.assertTrue(valid["currentValidatedDefinition"])
        self.assertEqual(valid["historicalMaterialIdentity"], "UNVERIFIED")
        data["chemistryAccessAvailable"] = False
        denied = rd.analyze(data)["projects"][0]["chemistryEvidenceCoverage"][0]
        self.assertFalse(denied["currentValidatedDefinition"])
        self.assertFalse(denied["chemistryAccessAvailable"])

    def test_no_chemistry_or_zero_measurements_does_not_fabricate_progress(self):
        result = rd.analyze(snapshot())
        self.assertEqual(result["projects"][0]["performanceStatus"], "NO_NEW_MEASURED_EVIDENCE")
        self.assertEqual(result["projects"][0]["comparisons"], [])
        self.assertEqual(result["projects"][0]["chemistryEvidenceCoverage"], [])
        self.assertEqual(rd.analyze(snapshot(experiments=[]))["projects"], [])

    def test_bad_or_ambiguous_time_windows_fail_closed(self):
        for field, value in (("windowEnd", "2026-10-14T00:00:00Z"), ("periodStart", "2026-10-01"), ("historyStart", "2026-10-10T00:00:00Z")):
            data = snapshot(); data[field] = value
            with self.assertRaises(ValueError): rd.analyze(data)

    def test_truncated_or_write_enabled_snapshot_fails_closed(self):
        for change in ({"truncated": True}, {"readOnly": False}):
            with self.assertRaises(ValueError): rd.analyze(snapshot() | change)


class LedgerTests(unittest.TestCase):
    def test_new_evidence_never_automatically_advances_a_proposal(self):
        prior = {"schemaVersion": 1, "ledgerEntries": rd.update_ledger(reviewed_updates=[proposal()])}
        output = rd.analyze(snapshot([scan("new", pce=30)]), prior_ledgers=[prior])
        entry = output["ledgerEntries"][0]
        self.assertEqual(entry["status"], "proposed")
        self.assertEqual(entry["revision"], 1)
        self.assertEqual(entry["history"], prior["ledgerEntries"][0]["history"])

    def test_reviewed_status_update_preserves_history_and_conflicting_revision_fails(self):
        prior = {"schemaVersion": 1, "ledgerEntries": rd.update_ledger(reviewed_updates=[proposal()])}
        update = proposal(expectedRevision=1, status="inconclusive", decisionNote="Source review: incomplete matched conditions; no conclusion.")
        result = rd.update_ledger([prior], [update])[0]
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["history"][0], prior["ledgerEntries"][0]["history"][0])
        self.assertEqual(result["status"], "inconclusive")
        with self.assertRaises(ValueError): rd.update_ledger([prior], [proposal(expectedRevision=2)])

    def test_sources_review_and_private_contract_are_mandatory(self):
        for change in ({"sourceReportIds": []}, {"evidenceIdentifiers": []}, {"reviewedBy": ""},
                       {"reviewedAt": "2026-10-13"}, {"smiles": "CCN"}, {"status": "supported"}, {"type": "executed"}):
            with self.assertRaises(ValueError): rd.update_ledger(reviewed_updates=[proposal(**change)])

    def test_conflicting_prior_histories_are_not_overwritten(self):
        entries = rd.update_ledger(reviewed_updates=[proposal()])
        altered = copy.deepcopy(entries)
        altered[0]["history"][0]["decisionNote"] = "Conflicting annotation"
        with self.assertRaises(ValueError): rd.update_ledger([{"schemaVersion": 1, "ledgerEntries": entries}, {"schemaVersion": 1, "ledgerEntries": altered}])

    def test_supersession_preserves_old_entry_and_project_identity(self):
        prior = {"schemaVersion": 1, "ledgerEntries": rd.update_ledger(reviewed_updates=[proposal()])}
        result = rd.update_ledger([prior], [proposal(entryId="rd-proposal-2", supersedesEntryId="rd-proposal-1")])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]["history"][0]["supersedesEntryId"], "rd-proposal-1")
        self.assertEqual(result[0]["status"], "proposed")
        with self.assertRaises(ValueError): rd.update_ledger([prior], [proposal(expectedRevision=1, projectAlias="P2")])

    def test_private_outputs_are_create_exclusive_and_owner_read_write(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private" / "dossier.json"
            rd.private_json(output, {"schemaVersion": 1})
            self.assertEqual(stat.S_IMODE(os.stat(output).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(output.parent).st_mode), 0o700)
            with self.assertRaises(FileExistsError): rd.private_json(output, {})


if __name__ == "__main__":
    unittest.main()
