import copy
import unittest

from ledger_audience import LedgerAudience, record_hash, verify_manager_html


class ManagerLedgerTests(unittest.TestCase):
    def setUp(self):
        self.secret = {"entryId":"private-1","sourceReportIds":["private-source"],"status":"proposed",
                       "statement":"A private ZXQ-derived candidate, TRIAL-ZXQ-K92, is intended for chemist review only.",
                       "history":[{"decisionNote":"The physicist has recorded that the validation experiment remains pending."}]}
        self.sibling = {"entryId":"private-2","sourceReportIds":["private-source"],"statement":"Consult a specialist about the route."}
        self.open = {"entryId":"open","sourceReportIds":["manager-source"],"status":"proposed","statement":"Repeat the SAM control.",
                     "history":copy.deepcopy(self.secret["history"])}
        self.ledger = [self.secret,self.sibling,self.open]

    def test_cohort_gating_and_public_quotations(self):
        frozen=copy.deepcopy(self.ledger)
        policy=LedgerAudience(self.ledger)
        self.assertEqual(policy.restricted,{"private-1","private-2"})
        self.assertFalse(policy.matches(self.open["history"][0]["decisionNote"]))
        for fragment in ["TRIAL‐ZXQ‐K92", "TRIAL-<strong>ZXQ</strong>-K92", "TRIAL-</td><td>ZXQ-K92",
                         "zxq-derived", "ZXQ 衍生", "以ZXQ为骨架", self.secret["statement"],
                         '<svg><title>TRIAL-ZXQ-K92</title></svg>', "<span aria-label='TRIAL-ZXQ-K92'></span>",
                         "<!--TRIAL-ZXQ-K92-->", "<p data-origin='TRIAL-ZXQ-K92'>safe</p>"]:
            with self.subTest(fragment=fragment), self.assertRaisesRegex(ValueError,"manager-facing"):
                verify_manager_html("<body>"+fragment+"</body>",policy)
        verify_manager_html("<p>Check device variation before repeating the controlled test.</p>", policy)
        wording={"en":"A matched repeat is planned.","zh":"计划在相同工艺下复测。"}
        status=policy.followup("private-2","no-new-direct-test",wording)
        self.assertIn("restricted research proposal",status["en"])
        self.assertNotEqual(policy.followup("open","no-new-direct-test",wording),wording)
        self.assertEqual(policy.followup("open","no-new-direct-test",wording,changed=True),wording)
        self.assertEqual(policy.followup("open","direct-test",wording),wording)
        self.assertEqual(self.ledger,frozen)
        self.assertEqual(record_hash(self.secret),record_hash(frozen[0]))

    def test_private_ledger_metadata_and_short_explicit_candidate_label(self):
        source={"entryId":"a","visibility":"CHEMIST_ONLY","statement":"Candidate XY92 is subject to specialist review.",
                "privateIdentifiers":["SyntheticProtectedName"],"privateScaffoldLabels":["特殊骨架"]}
        policy=LedgerAudience([source])
        for text in ("XY92","SyntheticProtectedName","特殊骨架"):
            with self.assertRaises(ValueError): verify_manager_html("<p>"+text+"</p>",policy)
