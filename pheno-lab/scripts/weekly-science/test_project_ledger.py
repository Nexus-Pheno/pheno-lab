import copy
import unittest

from project_ledger import (
    HistoricalWording,
    SID,
    add_to_sections,
    body,
    register,
    verify_view,
)


class ProjectLedgerTest(unittest.TestCase):
    def setUp(self):
        self.entry = dict(
            entryId="prior",
            projectAlias="a",
            revision=1,
            status="open",
            statement="The historical candidate LAB-17 came from a suggested material comparison.",
            history=[{"evidenceIdentifiers": []}],
        )
        self.old = {"ledgerEntries": [self.entry]}
        self.new = dict(
            projects=[{"projectAlias": "a"}, {"projectAlias": None}],
            ledgerEntries=[
                self.entry,
                dict(
                    self.entry,
                    entryId="new",
                    status="proposed",
                    projectAlias="UNASSIGNED",
                ),
            ],
        )
        self.binding = {
            "projects": {"P1": {"projectAlias": "a"}, "P2": {"projectAlias": None}},
            "cases": {"E1": {"code": "sample"}},
        }
        self.labels = [
            {"project": "P1", "english": "First group", "sourceName": "项目甲"},
            {"project": "P2", "english": "Unassigned experiments", "sourceName": None},
        ]
        self.review = {
            "projects": [
                {"project": "P1", "issueBindings": [{"entryId": "prior", "key": "L1"}]},
                {"project": "P2", "issueBindings": []},
            ]
        }
        self.follow = {
            "key": "L1",
            "assessment": "no-new-direct-test",
            "testedExperimentCodes": [],
            "rationale": {"en": "Archived private note.", "zh": "前期内部说明。"},
        }
        self.decisions = {
            "projects": [
                {"project": "P1", "issueAssessments": [self.follow]},
                {"project": "P2", "issueAssessments": []},
            ]
        }
        self.index = {
            "cases": [
                {"binding": {"experimentCode": "sample"}, "sectionId": "case-e1"}
            ],
            "followupAssessments": [],
        }

    def build(self):
        return register(
            self.old,
            self.new,
            self.binding,
            self.decisions,
            self.review,
            self.index,
            self.labels,
            {"sample"},
        )

    def sections(self, scope):
        def t(unassigned):
            return (
                "<table><tbody>"
                + "".join(
                    "<tr><td>"
                    + n
                    + "</td><td>D</td><td>private issue</td><td>N</td><td>C</td></tr>"
                    for n in ("项目甲", unassigned)
                )
                + "</tbody></table>"
            )

        sections = {
            "projects": {
                "id": "projects",
                "bodyEn": t("Unassigned"),
                "bodyZh": t("未分配"),
            },
            "case-e1": {"id": "case-e1"},
        }
        add_to_sections(sections, scope)
        return {"sections": list(sections.values())}

    def test_all_projects_counts_private_digests_and_bilingual_links(self):
        scope, issues = self.build()
        self.assertEqual(
            [(r["total"], r["noNew"], r["updated"]) for r in scope["projectRows"]],
            [(1, 1, 0), (0, 0, 0)],
        )
        self.assertEqual(scope["newEntryIds"], ["new"])
        self.assertEqual(len(issues), 1)
        doc = self.sections(scope)
        verify_view(doc, scope, self.old, self.new)
        for lang in ("en", "zh"):
            html = body(scope, lang)
            self.assertIn(f"#prior-project-{lang}-2", html)
            self.assertNotIn("private issue", str(doc))
            self.assertNotIn("LAB-17", html)
        broken = copy.deepcopy(doc)
        broken["sections"][-1]["bodyZh"] += "私密历史"
        with self.assertRaises(ValueError):
            verify_view(broken, scope, self.old, self.new)
        broken = copy.deepcopy(scope)
        broken["projectRows"][0]["records"][0]["baselineSha256"] = "x"
        with self.assertRaises(ValueError):
            verify_view(doc, broken, self.old, self.new)

    def test_partial_actual_and_changed_with_link_no_double_count_of_same_entry(self):
        change = dict(
            self.entry,
            revision=2,
            history=[*self.entry["history"], {"evidenceIdentifiers": ["sample"]}],
        )
        self.new["ledgerEntries"][0] = change
        self.index["followupAssessments"].append(
            {"entryId": "prior", "experiment": "E1", "assessment": "partial-test"}
        )
        scope, issues = self.build()
        first = scope["projectRows"][0]
        self.assertEqual(
            (first["total"], first["partial"], first["noNew"], first["updated"]),
            (1, 1, 0, 1),
        )
        self.assertEqual(issues[0]["evidenceIds"], ["sample"])
        self.assertIn('href="#case-e1"', body(scope, "zh"))
        verify_view(self.sections(scope), scope, self.old, self.new)

    def test_missing_or_false_project_and_unsupported_test_rejected(self):
        self.new["ledgerEntries"][0] = dict(self.entry, projectAlias="other")
        with self.assertRaises(ValueError):
            self.build()
        self.new["ledgerEntries"][0] = self.entry
        self.follow["assessment"] = "direct-test"
        with self.assertRaises(ValueError):
            self.build()
        self.follow["assessment"] = "no-new-direct-test"
        self.review["projects"][0]["issueBindings"].clear()
        with self.assertRaises(ValueError):
            self.build()

    def test_source_history_cannot_reappear_across_markup_or_as_identifier_in_appendix(
        self,
    ):
        wording = HistoricalWording(self.old)
        with self.assertRaises(ValueError):
            wording.verify(
                "<p>"
                + self.entry["statement"].replace("candidate", "<b>candidate</b>")
                + "</p>"
            )
        self.assertNotIn(
            "LAB-17",
            str(
                wording.pair(
                    {"en": "candidate LAB-17 showed improvement.", "zh": "旧样品。"}
                )
            ),
        )
        sections = [
            {"id": s, "bodyEn": "", "bodyZh": ""}
            for s in (SID, "project-purposes", "case-e1", "context")
        ]
        sections[-1]["bodyEn"] = "<p>candidate LAB-17</p>"
        doc = {
            "sections": sections,
            "evidenceMethodReview": {"experiments": [{"sectionId": "case-e1"}]},
        }
        with self.assertRaises(ValueError):
            wording.verify("<p>Manager summary</p>", doc)
        sections[2]["bodyEn"] = (
            "<p>Independently reviewed current comparison includes LAB-17.</p>"
        )
        wording.verify("<p>Manager summary</p>", doc)


if __name__ == "__main__":
    unittest.main()
