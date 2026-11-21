import copy
import unittest

from manager_material_names import ManagerMaterialNames, systematic
from ledger_audience import verify_inactive_followups


class NameProjectionTests(unittest.TestCase):
    def test_private_position_name_and_translation_bound_to_source_comparison(self):
        zh,en="合成-2-氨基苯甲酸盐","synthetic-2-aminobenzoic acid hydrochloride"
        snap = {"privateChemistryDefinitions":[{"name":zh},{"name":"2PACz"}],
                "experimentSummaries":[{"code":"e","title":"比较 SAM 添加剂","metadata":{
                    "testPlan":{"variables":[{"kind":"material", "values":{"A":"2PACz","B":zh}}]},
                    "aiSummary":{"analysis":{"purpose":{"en":"The "+en+" SAM additive was compared."}}}}}]}
        decisions={"projects":[{"routeIntents":[]}]}
        names=ManagerMaterialNames(snap,decisions)
        source={"titleEn":"A comparison of "+en,"summaryZh":"测定"+zh+"的表现。","key":"E-1",
                "sections":[{"id":"purpose","bodyEn":"<p>The "+en+" SAM additive improved neither method.</p>",
                             "bodyZh":"<p>该"+zh+"作为 SAM 添加剂。核对currentAccepted。</p>"}],
                "decisionReview":{"comparisonEn":"A "+en+" passivant was proposed.","sourceHash":"x"*64}}
        frozen=copy.deepcopy(source); names.project(source)
        self.assertEqual(source["sections"][0]["bodyEn"],"<p>The selected SAM additive improved neither method.</p>")
        self.assertIn("作为 SAM 添加剂",source["sections"][0]["bodyZh"])
        self.assertIn("系统采纳的器件结果",source["sections"][0]["bodyZh"])
        self.assertEqual(source["decisionReview"]["comparisonEn"],"A selected passivant was proposed.")
        self.assertEqual(source["decisionReview"]["sourceHash"],"x"*64)
        self.assertEqual(names.text("2PACz, A-17 and 0.4 mg/mL","en"), "2PACz, A-17 and 0.4 mg/mL")
        for inaccessible in [f"<meta name='description' content='{zh}'>",f"<svg><title>{en}</title></svg>",
                             f"<p>{en[:15]}<b>{en[15:]}</b></p>",f"<p>{zh[:4]}<em>{zh[4:]}</em></p>"]:
            with self.assertRaisesRegex(ValueError,"reconstructive|positional"): names.verify(inaccessible)
        self.assertIn(zh, frozen["summaryZh"])
        names.verify(source["sections"][0]["bodyEn"]+source["sections"][0]["bodyZh"])
        self.assertFalse(systematic("2PACz"))

    def test_unchanged_ledger_projection_and_updated_case(self):
        clause="The earlier screening comparison involved a tightly controlled synthetic history that should remain on its source record. "
        a={"key":"L1","assessment":"no-new-direct-test","rationale":{"en":clause,"zh":"待重复测试。"}}
        decisions={"projects":[{"project":"p","issueAssessments":[a]}]}
        receipts={"projects":[{"project":"p","issueBindings":[{"entryId":"entry","key":"L1"}]}]}
        with self.assertRaisesRegex(ValueError,"no-new-test"):
            verify_inactive_followups("<p>"+clause+"</p>",decisions,receipts,{"followupAssessments":[]},[])
        verify_inactive_followups("<p>No new direct test this week.</p>",decisions,receipts,{"followupAssessments":[]},[])
        verify_inactive_followups("<p>"+clause+"</p>",decisions,receipts,{"followupAssessments":[]},[{"entryId":"entry"}])
