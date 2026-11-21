"""Boundary, evidence and candidate-selection regressions. Synthetic materials only."""

import unittest
from unittest.mock import patch

import prepare
import private_science


class ProjectionTests(unittest.TestCase):
    def test_metric_and_source_payload_are_allowlisted(self):
        values = {
            "pce": {
                "n": 2,
                "mean": 12.5,
                "best": 13.0,
                "sd": None,
                "sampleCode": "UNIT-TEST-ID",
            },
            "ff": None,
            "smiles": "do-not-copy",
        }
        output = prepare.moments(values)
        self.assertEqual(set(output), {"pce"})
        self.assertIsNone(output["pce"]["sd"])
        self.assertNotIn("sampleCode", output["pce"])
        with self.assertRaises(ValueError):
            prepare.moments({"pce": {"n": True}})

    def test_open_questions_rank_before_unrelated_late_receipts(self):
        rows = [{"id": "E" + str(i), "project": "P" + str(i), "newlyMeasuredSources": 0,
                 "freshMeasuredSources": 0, "newSourceAliases": 20 if i == 1 else 0, "eligible": i != 5} for i in range(1, 6)]
        self.assertEqual(prepare.cases_for_detail(rows, ["E4", "E5", "E3"]), ["E4", "E3", "E1"])

    def test_fresh_measurements_win_over_repeated_scans_other_projects_and_late_receipts(self):
        # One high-volume case has scans in the reporting week but already seen;
        # another also has unseen old receipts, so neither marginal count nor their minimum works.
        rows = [{"id": eid, "project": proj, "freshMeasuredSources": fresh,
                 "newlyMeasuredSources": window, "newSourceAliases": unseen, "eligible": True}
                for eid, proj, fresh, window, unseen in [
                    ("E1", "P1", 0, 150, 150), ("E2", "P2", 10, 10, 10),
                    ("E3", "P2", 2, 4, 2), ("E4", "P3", 1, 1, 1)]]
        self.assertEqual(prepare.cases_for_detail(rows), ["E2","E4","E3"])

    def test_select_by_scientific_coverage(self):
        inputs = [
            {
                "id": "E" + str(i),
                "project": project,
                "newlyMeasuredSources": measurements,
                "freshMeasuredSources": measurements,
                "newSourceAliases": 0,
                "eligible": True,
            }
            for i, project, measurements in [
                (1, "P1", 30),
                (2, "P1", 20),
                (3, "P2", 5),
                (4, "P3", 3),
            ]
        ]
        self.assertEqual(prepare.cases_for_detail(inputs), ["E1", "E3", "E4"])

    def test_condition_fields_do_not_copy_name_or_recipe(self):
        private = {
            "conditions": [
                {
                    "parameterName": "private formula 溶剂",
                    "plannedValues": {"A": "secret-formulation"},
                    "actualByGroup": {
                        "A": {
                            "status": "RETROSPECTIVE",
                            "nPlannedSamples": 3,
                            "nRecordedSamples": 2,
                            "records": [{"note": "secret"}],
                        }
                    },
                }
            ]
        }
        self.assertEqual(
            prepare.actual_factors(private, {"A": "G1"}),
            [
                {
                    "kind": "carrier",
                    "group": "G1",
                    "status": "RETROSPECTIVE",
                    "plannedDevices": 3,
                    "recordedDevices": 2,
                }
            ],
        )
        self.assertNotIn(
            "someone@", private_science.scientific_text("contact someone@example.net")
        )
        self.assertNotIn(
            "https://",
            private_science.scientific_text("see https://example.org/private"),
        )
        with self.assertRaises(ValueError):
            private_science.scientific_text("A" * 12001)

    def test_public_discovery_filters_retracted_and_future_articles(self):
        item = {
            "doi": "https://doi.org/10.1234/unit-test",
            "title": "A measured perovskite passivation comparison",
            "type": "article",
            "is_retracted": False,
            "is_paratext": False,
            "id": "https://openalex.org/W12345678",
            "publication_date": "2026-01-01",
            "abstract_inverted_index": {
                "perovskite": [0],
                "original": [1],
                "study": [2],
                "x" * 111: [3],
            },
        }
        with patch.object(
            prepare,
            "fetch_json",
            return_value={
                "results": [
                    dict(item, is_retracted=True),
                    dict(item, publication_date="2027-01-01"),
                    item,
                ]
            },
        ):
            articles, audit = prepare.discover_articles("2026-03-01T00:00:00Z", [])
        self.assertEqual([r["paper"] for r in articles], ["S1"])
        self.assertEqual(len(audit), 2)
        self.assertEqual(len(articles[0]["sourceHash"]), 64)


if __name__ == "__main__":
    unittest.main()
