"""Synthetic quiet-period source selection, disclosure and canonical empty primary gate."""
import copy
import unittest

import period_scope
import shared_app_evidence as shared
import validate_primary_evidence as primary
from test_shared_app_evidence import fixture


START = "2025-01-08T01:00:00Z"
END = "2025-01-15T01:00:00Z"


def scan(alias, date, code="A", **fields):
    return {"measurementAlias": alias, "experimentCode": code, "measuredAt": date,
            "sourceLinked": True, "metrics": {"pce": 12, "voc": 1},
            "measuredInPeriod": date is not None and START <= date < END, **fields}


def dataset():
    contexts = [{"code": key, "projectAlias": key} for key in "ABCDE"]
    current = {"windowEnd": END, "periodStart": START, "snapshotAt": END, "experimentSummaries": contexts,
               "historicalSampleMeasurements": [], "sampleMeasurements": []}
    entries = [{"experimentCode": key, "evidence": {"sourceHash": str(i) * 64, "characterizations": [
        {"groups": [{"metrics": {"pce": {"n": int(key != "D")}}}]}]}} for i, key in enumerate("ABCD")]
    previous = {**copy.deepcopy(current), "windowEnd": START, "sharedAppEvidence": {"experiments": entries}}
    ledger = [{"entryId": "q" + key, "evidenceIdentifiers": [key], "status": status, "sourceReportIds": [report]}
              for key, status, report in [("A", "completed", "previous"), ("B", "proposed", "previous"),
                                          ("C", "inconclusive", "older"), ("D", "proposed", "previous")]]
    meta = {"reportId": "previous", "snapshotSha256": "8" * 64, "dossierPublishedSha256": "9" * 64}
    return current, previous, {"ledgerEntries": ledger}, meta


class QuietPeriodTests(unittest.TestCase):
    def test_closed_or_unmeasured_predictions_never_promoted(self):
        current, prior, dossier, meta = dataset()
        current["experimentSummaries"][-1]["updatedInPeriod"] = True
        current["sampleMeasurements"] = [scan("late", "2025-01-01T01:00:00Z", receivedInPeriod=True),
                                         scan("undated", None, isPeriodEvidence=True),
                                         scan("old", START), scan("bad", END, metrics={"pce": 12, "voc": -1})]
        prior["sampleMeasurements"] = [scan("old", START)]
        result = period_scope.derive(current, prior, dossier, meta)
        self.assertEqual(result["mode"], "CARRIED_FORWARD")
        self.assertEqual(result["newEligibleMeasuredAliases"], 0)
        self.assertEqual(result["requestedExperimentCodes"], ["A", "B", "C", "E"])
        self.assertEqual([item["experimentCode"] for item in result["followups"]], ["B", "C"])
        self.assertEqual(result["followups"][0]["openLedgerEntryIds"], ["qB"])
        self.assertTrue(all(item["openLedgerEntryIds"] for item in result["followups"]))
        historical = period_scope.derive(current, prior, {"ledgerEntries": []}, meta)
        self.assertTrue(historical["followups"])
        self.assertTrue(all(item["reason"] == "ACCEPTED_DEVICE_CONTEXT_FROM_LAST_EXPORT"
                            and not item["openLedgerEntryIds"] for item in historical["followups"]))
        self.assertEqual(result["previousSnapshotSha256"], meta["snapshotSha256"])

    def test_first_seen_in_window_new_measurement_restores_full_ordinary_scope(self):
        current, prior, dossier, meta = dataset()
        current["sampleMeasurements"] = [scan("new", START, code="E"), scan("at-end", END)]
        current["experimentSummaries"][0]["newInPeriod"] = True
        result = period_scope.derive(current, prior, dossier, meta)
        self.assertEqual(result["mode"], "NEW_MEASUREMENTS")
        self.assertEqual(result["requestedExperimentCodes"], ["A", "E"])
        self.assertEqual(result["newEligibleMeasuredAliases"], 1)
        self.assertEqual(result["followups"], [])

    def test_missing_or_no_longer_visible_prior_cases_are_never_invented(self):
        current, prior, dossier, meta = dataset()
        current["experimentSummaries"] = [{"code": "NEW"}]
        result = period_scope.derive(current, prior, dossier, meta)
        self.assertEqual(result["requestedExperimentCodes"], [])
        self.assertEqual(result["followups"], [])

    def test_actual_empty_export_can_pass_primary_gate_but_needs_reviewed_empty_scope(self):
        doc, snap, dossier = fixture()
        snap["sharedAppEvidence"]["experiments"] = []
        doc["evidenceMethodReview"].update(experiments=[], omittedExperimentCount=0)
        dossier["primaryExperimentEvidence"] = shared.dossier_primary_evidence(snap)
        self.assertTrue(primary.validate(doc, snap, dossier)["passed"])
        doc["evidenceMethodReview"]["omittedExperimentCount"] = 1
        self.assertFalse(primary.validate(doc, snap, dossier)["passed"])

    def test_overlapping_week_shows_each_case_measurement_intersection(self):
        current, prior, _, _ = dataset()
        old = scan("seen", START, code="A")
        current["sampleMeasurements"] = [old, scan("fresh", START, code="B"),
                                         scan("late", "2024-12-26T01:00:00Z", code="A", receivedInPeriod=True)]
        prior["sampleMeasurements"] = [old]
        doc = {"evidenceMethodReview":{"experiments":[{"experimentCode":c,"sectionId":c} for c in "AB"]},
               "sections":[{"id":c,"bodyEn":"Data","bodyZh":"数据"} for c in "AB"]}
        period_scope.add_scope_note(doc, current, prior)
        self.assertIn("one eligible", doc["sections"][0]["bodyEn"])
        self.assertIn("1 条", doc["sections"][1]["bodyZh"])
        period_scope.verify_scope_note(doc, current, prior)
        doc["sections"][0]["bodyZh"] = "数据"
        with self.assertRaises(ValueError):
            period_scope.verify_scope_note(doc, current, prior)

    def test_older_measurement_cannot_become_new_direct_test_for_either_reviewer(self):
        current, prior, _, _ = dataset()
        old = scan("seen", START, code="A")
        current["sampleMeasurements"] = [old, scan("recent", START, code="B")]
        prior["sampleMeasurements"] = [old]
        bind = {"cases":{"E1":{"code":"A"}}}
        index = {"followupAssessments":[{"experiment":"E1","assessment":"direct-test"}]}
        decisions = {"projects":[{"issueAssessments":[{"assessment":"direct-test","testedExperimentCodes":["B"]}]}]}
        with self.assertRaises(ValueError):
            period_scope.verify_followup_timing(current, prior, index, decisions, bind)
        index["followupAssessments"][0]["assessment"] = "no-new-direct-test"
        period_scope.verify_followup_timing(current, prior, index, decisions, bind)
        decisions["projects"][0]["issueAssessments"][0]["testedExperimentCodes"].append("A")
        with self.assertRaises(ValueError):
            period_scope.verify_followup_timing(current, prior, index, decisions, bind)

    def test_bilingual_notice_bound_to_real_export_asof_and_checked_on_sealed_document(self):
        current, prior, dossier, meta = dataset()
        current["weeklyCollectionScope"] = period_scope.derive(current, prior, dossier, meta)
        current["sharedAppEvidence"] = {"asOf": "2025-01-15T03:53:00Z"}
        doc = {"sections": [{"id": "projects", "bodyEn": "Details", "bodyZh": "详情"}]}
        with self.assertRaises(ValueError):
            period_scope.verify_scope_note(doc, current)
        period_scope.add_scope_note(doc, current)
        period_scope.verify_scope_note(doc, current)
        for key in ("bodyEn", "bodyZh"):
            self.assertIn("2025-01-15 11:53", doc["sections"][0][key])
        current["sharedAppEvidence"]["asOf"] = "2025-01-15T03:55:00Z"
        with self.assertRaises(ValueError):
            period_scope.verify_scope_note(doc, current)
