import unittest

from assemble_science import aging_record_evidence, display_case_groups


class CaseDisplayTest(unittest.TestCase):
    def setUp(self):
        self.bound = {"code": "test", "sourceHash": "f" * 64}
        self.groups = {"G3": "C", "G8": "H"}
        self.snapshot = {
            "sharedAppEvidence": {"experiments": [{"experimentCode": "test", "evidence": {
                "sourceHash": self.bound["sourceHash"], "characterizations": [{"name": "J-V"}]}}]},
            "experimentSummaries": [{"code": "test", "runs": [{"status": "IN_PROGRESS"}],
                "characterizations": [{"name": "J-V"}], "samples": []}],
            "sampleMeasurements": [{"experimentCode": "test", "condition": "LIGHT"}],
            "historicalSampleMeasurements": [],
        }
        self.raw = {"name": {"en": "Initial PCE only; aging not executed.", "zh": "仅有初始效率；老化未执行。"},
                    "conditions": [{"group":"G3", "execution":{"en":"Aging was not performed; n=3.", "zh":"未开展老化测试；3片。"}}],
                    "comparison":{"en":"G3-G8 are exploratory; material SAM-G8 is separate.", "zh":"G3-G8 仅供参考。"}}

    def render(self):
        return display_case_groups(self.raw, self.groups, {"E1": self.bound}, aging_record_evidence(self.snapshot, self.bound))

    def test_missing_aging_record_and_complete_group_range(self):
        result = self.render()
        self.assertIn("no aging test result is recorded", result["name"]["en"])
        self.assertIn("未见老化测试结果记录", result["conditions"][0]["execution"]["zh"])
        self.assertEqual(result["conditions"][0]["group"], "G3")
        self.assertEqual(result["comparison"]["en"], "C–H are exploratory; material SAM-G8 is separate.")
        self.assertEqual(result["comparison"]["zh"], "C–H 仅供参考。")
        self.assertIn("not executed", self.raw["name"]["en"])

    def test_recorded_or_ambiguous_aging_data_require_scientific_review(self):
        self.snapshot["experimentSummaries"][0]["characterizations"].append({"name": "T80 stability"})
        with self.assertRaisesRegex(ValueError, "scientific review required"):
            self.render()

    def test_changed_hash_or_unavailable_squarely_blocks_claim(self):
        self.snapshot["sharedAppEvidence"]["experiments"][0]["evidence"]["sourceHash"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "scientific review required"):
            self.render()

    def test_unknown_endpoint_is_never_left_in_range(self):
        self.raw["comparison"]["en"] = "G3-G9 are exploratory"
        with self.assertRaisesRegex(ValueError, "unbound"):
            self.render()


if __name__ == "__main__":
    unittest.main()
