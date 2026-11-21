import unittest


class ProjectDisplayTests(unittest.TestCase):
    def test_bilingual_project_labels_use_names_without_mutating_source_ids(self):
        from assemble_science import display_project_text

        names = {"P1": {"name": "Pilot"}, "P3": {"name": None}}
        source = {"project": "P1", "decision": {"en": "P1 and P3", "zh": "P1和P3"}}
        out = display_project_text(source, names)
        self.assertEqual(
            out["decision"],
            {"en": "Pilot and Unassigned experiments", "zh": "Pilot和未分配项目"},
        )
        self.assertEqual(out["project"], "P1")
        self.assertEqual(source["decision"]["en"], "P1 and P3")
        with self.assertRaises(ValueError):
            display_project_text({"en": "source " + ("a" * 64)}, names)
