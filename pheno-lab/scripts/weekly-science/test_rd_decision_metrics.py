#!/usr/bin/env python3
"""Synthetic decision-metric boundaries; no production data or writes."""
import copy
import unittest

from test_rd_analysis import rd, scan, experiment, snapshot


def project_for(rows, experiments=None, **changes):
    return rd.analyze(snapshot(rows, experiments=experiments) | changes)["projects"][0]


def cohorts(project, view="STRICT_RECORDED_PROTOCOL", period="CURRENT_PERIOD"):
    return [item for item in project["periodPerformance"]["routeCohorts"]
            if item["view"] == view and item["periodCohort"] == period]


class DecisionMetricTests(unittest.TestCase):
    def test_scan_champion_mean_and_best_sample_median_are_different_estimands(self):
        rows = [scan("a", pce=10), scan("b", pce=10), scan("c", pce=40), scan("d", sample="s2", pce=25)]
        panel = cohorts(project_for(rows))[0]
        self.assertEqual(panel["inferenceOutcomes"]["metrics"]["pce"]["mean"], 17.5)
        self.assertEqual(panel["inferenceOutcomes"]["metrics"]["pce"]["median"], 17.5)
        self.assertEqual(panel["pceExtremes"]["championValidScan"]["pce"], 40)
        self.assertEqual(panel["pceExtremes"]["championValidScan"]["measurementAliases"], ["c"])
        self.assertEqual(panel["pceExtremes"]["bestPhysicalSampleMedian"]["pce"], 25)
        self.assertEqual(panel["pceExtremes"]["bestPhysicalSampleMedian"]["sampleAliases"], ["s2"])
        self.assertEqual(panel["inferenceOutcomes"]["nSamples"], 2)
        self.assertEqual(panel["inferenceOutcomes"]["nScans"], 4)
        within = panel["withinDeviceDispersion"][0]["metrics"]["pce"]
        self.assertEqual(within["nScans"], 3)
        self.assertNotIn("nSamples", within)
        self.assertEqual(within["denominatorUnit"], "SCANS_WITHIN_ONE_PHYSICAL_SAMPLE")

    def test_repeated_scans_never_weight_the_between_sample_mean(self):
        short = cohorts(project_for([scan("a", pce=10), scan("b", sample="s2", pce=20)]))[0]
        repeated = cohorts(project_for([scan("repeat" + str(i), pce=10) for i in range(30)] +
            [scan("b", sample="s2", pce=20)]))[0]
        self.assertEqual(short["inferenceOutcomes"]["metrics"]["pce"], repeated["inferenceOutcomes"]["metrics"]["pce"])
        self.assertEqual(repeated["inferenceOutcomes"]["metrics"]["pce"]["mean"], 15)
        self.assertIsNone(repeated["inferenceOutcomes"]["independentBatchCount"])

    def test_per_metric_denominator_and_tied_champions_preserved(self):
        rows = [scan("a", pce=20), scan("b", sample="s2", metrics={"pce": 20, "voc": None, "ff": 80, "area": 1})]
        panel = cohorts(project_for(rows))[0]
        self.assertEqual(panel["inferenceOutcomes"]["metrics"]["voc"]["nSamples"], 1)
        self.assertEqual(panel["inferenceOutcomes"]["metrics"]["jsc"]["nSamples"], 1)
        self.assertIsNone(panel["inferenceOutcomes"]["metrics"]["voc"]["sampleStandardDeviation"])
        self.assertEqual(panel["pceExtremes"]["championValidScan"]["measurementAliases"], ["a", "b"])
        self.assertEqual(panel["pceExtremes"]["bestPhysicalSampleMedian"]["sampleAliases"], ["s1", "s2"])

    def test_current_previous_equal_duration_and_earlier_history_stay_distinct(self):
        rows = [scan("now", pce=10), scan("prior", pce=8, measuredAt="2026-10-03T00:00:00Z"),
                scan("history", pce=6, measuredAt="2026-09-20T00:00:00Z")]
        project = project_for(rows)
        panels = project["periodPerformance"]
        self.assertEqual(panels["windows"]["PREVIOUS_EQUAL_DURATION_PERIOD"]["start"], "2026-09-29T00:00:00+00:00")
        self.assertEqual(len(panels["routeCohorts"]), 6)
        pairs = [pair for pair in panels["routeComparisons"] if pair["view"] == "STRICT_RECORDED_PROTOCOL"]
        self.assertEqual(len(pairs), 2)
        self.assertEqual({pair["referencePeriod"]: pair["metricDifferencesCurrentMinusReference"]["pce"]["mean"]
            for pair in pairs}, {"PREVIOUS_EQUAL_DURATION_PERIOD": 2, "EARLIER_HISTORY": 4})
        self.assertTrue(all(pair["comparisonStatus"] == "CONDITIONAL_DESCRIPTIVE_COMPARISON_UNVERIFIED" for pair in pairs))
        self.assertTrue(all(pair["sharedPhysicalSamples"] == 1 for pair in pairs))
        self.assertTrue(all(pair["independentManufacturingReplicationVerified"] is False for pair in pairs))
        self.assertIsNone(panels["projectPooledPerformance"])

    def test_late_receipts_and_undated_rows_do_not_become_current_measured_progress(self):
        rows = [scan("late", pce=25, measuredAt="2026-09-20T00:00:00Z"),
                scan("undated", pce=30, measuredAt=None, timeBasis="received")]
        project = project_for(rows)
        self.assertEqual(cohorts(project), [])
        self.assertEqual(cohorts(project, period="EARLIER_HISTORY")[0]["measurementAliases"], ["late"])
        self.assertEqual(project["periodPerformance"]["undatedMeasurementRowsExcludedFromPeriodPerformance"], 1)
        self.assertEqual(project["receivedOlderMeasurementsDuringPeriod"], 1)
        self.assertTrue(all(pair["comparisonStatus"] == "UNAVAILABLE" for pair in project["periodPerformance"]["routeComparisons"]))

    def test_changed_protocols_are_side_by_side_without_computed_trend(self):
        rows = [scan("now", pce=20), scan("prior", pce=10, settings={"scanSpeed": 200, "areaDefinition": "active"},
                measuredAt="2026-10-03T00:00:00Z")]
        project = project_for(rows)
        self.assertEqual(len(project["periodPerformance"]["routeCohorts"]), 4)
        for pair in project["periodPerformance"]["routeComparisons"]:
            self.assertEqual(pair["comparisonStatus"], "UNAVAILABLE")
            self.assertIsNone(pair["metricDifferencesCurrentMinusReference"]["pce"]["mean"])

    def test_limited_protocol_removes_only_trace_name_and_keeps_full_evidence(self):
        base = {"scanSpeed": 100, "areaDefinition": "active"}
        rows = [scan("a", settings=base | {"traceName": "trace-one"}),
                scan("b", sample="s2", pce=20, settings=base | {"traceName": "trace-two"}),
                scan("c", measuredAt="2026-10-03T00:00:00Z", settings=base | {"traceName": "old-trace"})]
        project = project_for(rows)
        self.assertEqual(len(cohorts(project)), 2)
        limited = cohorts(project, view="TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL")[0]
        self.assertEqual(limited["inferenceOutcomes"]["metrics"]["pce"]["mean"], 15)
        self.assertEqual(len(limited["fullSettingsHashes"]), 2)
        self.assertEqual(len(limited["fullRecordedProtocolSignatures"]), 2)
        self.assertEqual(limited["excludedIdentityKeys"], ["traceName"])
        self.assertIn("unrecorded_irradiance", limited["comparabilityIssues"])
        pairs = [pair for pair in project["periodPerformance"]["routeComparisons"]
                 if pair["view"] == "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL" and pair["referencePeriod"] == "PREVIOUS_EQUAL_DURATION_PERIOD"]
        self.assertEqual(pairs[0]["metricDifferencesCurrentMinusReference"]["pce"]["mean"], 5)
        self.assertEqual(pairs[0]["comparisonStatus"], "CONDITIONAL_DESCRIPTIVE_COMPARISON_UNVERIFIED")

    def test_runs_and_actual_conditions_are_not_pooled_or_inferred_from_names(self):
        exp = experiment()
        exp["steps"][0]["executions"][1]["actuals"] = {"speed": "20"}
        rows = [scan("a"), scan("b", runAlias="R2", pce=20), scan("c", group="B", pce=30)]
        project = project_for(rows, [exp])
        self.assertEqual(len(cohorts(project)), 3)
        self.assertEqual(len(cohorts(project, view="TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL")), 3)
        self.assertEqual(len({panel["routeId"] for panel in cohorts(project)}), 3)

    def test_failed_arms_remain_visible_but_do_not_create_zero_or_yield_denominators(self):
        rows = [scan("good", pce=10), scan("failed", sample="s2", pce=0, group="ERROR"),
                scan("invalid", sample="s3", pce=90, group="B")]
        project = project_for(rows)
        self.assertEqual(cohorts(project)[0]["inferenceOutcomes"]["nSamples"], 1)
        inventory = {row["measurementAlias"]: row for row in project["excludedMeasurementInventory"]}
        self.assertEqual(set(inventory), {"failed", "invalid"})
        self.assertEqual(inventory["failed"]["group"], "ERROR")
        self.assertFalse(inventory["failed"]["performanceInferenceEligible"])
        self.assertIn("current_error_extra_sample", inventory["failed"]["exclusionReasons"])

    def test_collector_filtered_failed_sample_remains_in_arm_inventory_without_invented_scans(self):
        exp = experiment(samples=["s1", "s2"])
        exp["samples"] = [{"sampleAlias": "s1", "code": "S1", "variationGroup": "A", "note": "", "results": []},
            {"sampleAlias": "s2", "code": "S2", "variationGroup": "ERROR", "note": "Recorded failure note", "results": []}]
        project = project_for([scan("good")], [exp])
        arms = project["experiments"][0]["recordedSampleArmInventory"]
        self.assertEqual(len(arms), 2)
        self.assertTrue(arms[1]["excludedByCurrentErrorExtraFlag"])
        self.assertEqual(arms[1]["recordedNote"], "Recorded failure note")
        self.assertEqual(arms[1]["originalTreatmentAndYieldDenominator"], "UNVERIFIED")
        self.assertEqual(project["excludedMeasurementInventory"], [])
        self.assertEqual(cohorts(project)[0]["inferenceOutcomes"]["nSamples"], 1)

    def test_inconsistent_vector_cannot_be_the_champion(self):
        rows = [scan("bad", pce=40, metrics={"pce": 40, "voc": 0, "jsc": 20, "ff": 80, "area": 1}),
                scan("good", sample="s2", pce=10)]
        panel = cohorts(project_for(rows))[0]
        self.assertEqual(panel["pceExtremes"]["championValidScan"]["pce"], 10)
        self.assertEqual(panel["measurementAliases"], ["good"])
        self.assertEqual(panel["descriptiveMeasurementAliases"], ["bad", "good"])
        self.assertEqual(panel["inferenceOutcomes"]["internallyInconsistentScanCountExcluded"], 1)
        only_bad = cohorts(project_for(rows[:1]))[0]
        self.assertIsNone(only_bad["pceExtremes"]["championValidScan"])
        self.assertIsNone(only_bad["inferenceOutcomes"]["metrics"]["pce"]["mean"])

    def test_partially_covered_previous_period_has_no_difference(self):
        project = project_for([scan("now"), scan("prior", measuredAt="2026-10-05T00:00:00Z")],
            historyStart="2026-10-04T00:00:00Z", windowStart="2026-10-04T00:00:00Z", contextStart="2026-10-04T00:00:00Z")
        pair = next(item for item in project["periodPerformance"]["routeComparisons"]
            if item["view"] == "STRICT_RECORDED_PROTOCOL" and item["referencePeriod"] == "PREVIOUS_EQUAL_DURATION_PERIOD")
        self.assertEqual(pair["comparisonStatus"], "UNAVAILABLE")
        self.assertIn("PREVIOUS_PERIOD_NOT_FULLY_COVERED_BY_SOURCE_HISTORY", pair["unavailableReasons"])
        self.assertIsNone(pair["metricDifferencesCurrentMinusReference"]["pce"]["mean"])

    def test_design_fields_are_retained_without_reinterpreting_legacy_meaning_or_time(self):
        source = experiment(observation="Recorded failure analysis", problem="Recorded DOE design", hypothesis="Recorded purpose",
            metadata={"testPlan": {"variable": "Synthetic factor", "control": "Synthetic control"}},
            submittedAt="2026-10-02T00:00:00Z", approvedAt="2026-10-03T00:00:00Z")
        source_before = copy.deepcopy(source)
        item = project_for([], [source])["experiments"][0]
        intent = item["recordedDesignIntent"]
        self.assertEqual(intent["sourceFields"]["observation"], source["observation"])
        self.assertEqual(intent["sourceFields"]["problem"], source["problem"])
        self.assertEqual(intent["sourceMetadataTestPlan"], source["metadata"]["testPlan"])
        self.assertEqual(intent["sourceTimestamps"]["submittedAt"], source["submittedAt"])
        self.assertEqual(intent["metadataBasis"], "CURRENT_AT_SNAPSHOT_NOT_A_RECONSTRUCTED_PRE_EXPERIMENT_DESIGN")
        self.assertEqual(intent["nextDesignOutcomesCriteriaAndBranches"], "REPORT_PROPOSALS_ONLY_NOT_INFERRED_SOURCE_RECORDS")
        self.assertEqual(source, source_before)
        missing = rd.recorded_design_intent({"hypothesis": "", "problem": "A recorded design"})
        self.assertEqual(missing["sourceFieldAvailability"]["observation"], "NOT_COLLECTED")
        self.assertEqual(missing["sourceFieldAvailability"]["hypothesis"], "RECORDED_EMPTY")


if __name__ == "__main__":
    unittest.main()
