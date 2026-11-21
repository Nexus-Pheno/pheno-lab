import copy
import unittest

from project_names import names_from_source, translate_project_names, verify_project_names


class ProjectNameTests(unittest.TestCase):
    def inputs(self, label, gloss=None):
        snapshot = {"projectInventory":[{"projectAlias":"source", "projectName":label}, {"projectAlias":None, "label":"UNASSIGNED"}]}
        bindings = {"P9":{"name":label,"projectAlias":"source"}, "P2":{"name":None,"projectAlias":None}}
        decisions = {"projects":[{"project":"P2"},{"project":"P9", **({"projectNameEn":gloss} if gloss else {})}]}
        return snapshot, bindings, decisions

    def test_frozen_source_vocabulary_and_freshly_reviewed_unknown_name(self):
        for label, expected in [("表征检测组","Characterization and Testing Group"),
                                ("宽带隙电池与组件组","Wide-Bandgap Cells and Modules Group"),
                                ("SAM 材料验证组","SAM Materials Validation Group"),
                                ("基底产品开发与生产组","Substrate Product Development and Production Group"),
                                ("材料合成","Materials Synthesis"),("Optics","Optics")]:
            names = names_from_source(*self.inputs(label))
            self.assertEqual([(r["project"], r["english"]) for r in names], [("P9",expected),("P2","Unassigned experiments")])
        source=self.inputs("导电层甲组","Conductive Layer Team A")
        self.assertEqual(names_from_source(*source)[0]["english"], "Conductive Layer Team A")
        snapshot, bindings, decisions = source
        bindings["P9"]["name"] = "导电层乙组"
        with self.assertRaisesRegex(ValueError,"frozen"): names_from_source(snapshot,bindings,decisions)
        for label, gloss in [("材料合成拓展项目",None),("新项目","新项目"),("新项目","<a>x</a>"),("Новая группа",None)]:
            with self.assertRaisesRegex(ValueError,"reviewed"): names_from_source(*self.inputs(label,gloss))

    def test_rendering_changes_only_visible_english_prose_and_preserves_official_label(self):
        label="表征检测组"
        labels=names_from_source(*self.inputs(label))
        def part(key, en):
            return {"id":key,"bodyEn":en,"bodyZh":"<h3>"+label+"</h3>"}
        doc={"sections":[part("projects","<td>"+label+"</td><td>Unassigned</td>"),
                         part("project-purposes","<h3>"+label+"</h3><h3>Unassigned</h3>"),
                         part("routes","<h3>"+label+"</h3><h3>Unassigned experiments</h3>"),
                         part("other",'<a title="'+label+'">'+label+'</a>')],
             "decisionReview":{"binding":"P9","reasonEn":"Check "+label, "reasonZh":label}}
        frozen=copy.deepcopy(doc)
        translate_project_names(doc,labels); verify_project_names(doc,labels)
        self.assertEqual(doc["sections"][3]["bodyEn"],'<a title="'+label+'">Characterization and Testing Group</a>')
        self.assertEqual(doc["decisionReview"]["binding"],"P9")
        self.assertEqual(doc["decisionReview"]["reasonZh"],label)
        self.assertEqual(doc["decisionReview"]["reasonEn"],"Check Characterization and Testing Group")
        self.assertEqual([s["bodyZh"] for s in doc["sections"]],[s["bodyZh"] for s in frozen["sections"]])
        doc["sections"][2]["bodyEn"]="<h3>Wrong project name</h3>"
        with self.assertRaisesRegex(ValueError,"Missing English"): verify_project_names(doc,labels)
