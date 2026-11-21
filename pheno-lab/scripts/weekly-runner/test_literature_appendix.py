"""Source notes must match what the scientist read and the cases they cited."""

from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from literature_appendix import bound_notes, digest, source_appendix


def bi(en="Measured coverage differed.", zh="实测覆盖情况有差异。"):
    return {"en": en, "zh": zh}


class Content(HTMLParser):
    def __init__(self):
        super().__init__()
        self.words = []
        self.links = []

    def handle_data(self, data):
        self.words.append(data)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.append(dict(attrs)["href"])


class LiteratureAppendixTest(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.sha = "abc01234" * 8
        self.papers = [
            dict(
                paper=p,
                doi="10.1234/" + p,
                title=p + " public paper",
                abstract="Observed change in film coverage.",
            )
            for p in ("S1", "S2")
        ]
        self.notes = dict(
            caseTitles=[dict(experiment="E1", publishRecordedTitle=True)],
            articles=[
                dict(
                    paper="S1",
                    finding=bi(),
                    studyLimit=bi(),
                    uses=[
                        dict(
                            experiment="E1",
                            relevance=bi("Compare mapped coverage.", "比较覆盖分布。"),
                            limit=bi("Different electrode.", "电极不同。"),
                        )
                    ],
                ),
                dict(paper="S2", finding=bi(), studyLimit=bi(), uses=[]),
            ],
        )
        self.sci = dict(
            cases=[
                dict(
                    experiment="E1",
                    sourceHash=self.sha,
                    chemical=dict(sources=["S1"], limitations=["Different contact."]),
                )
            ],
            literatureNotes=self.notes,
        )
        self.app = {"x-7": dict(sourceHash=self.sha, experiment=dict(title="实验名称"))}
        self.cases = [
            dict(
                case="E1",
                sectionId="case-e1",
                binding=dict(experimentCode="x-7", sourceHash=self.sha),
                displayPublic=dict(name=bi("Film coverage trial", "成膜覆盖验证")),
            )
        ]
        self.private = dict(
            cases=[dict(experiment="E1", sourceHash=self.sha, title="实验名称")],
            articles=[
                {"id": a["paper"], **{k: a[k] for k in ("doi", "abstract", "title")}}
                for a in self.papers
            ],
        )
        self.write("private-scientific-facts.json", self.private)

    def write(self, key, value):
        (self.root / key).write_text(json.dumps(value, ensure_ascii=False))

    def render(self):
        return source_appendix(self.root, self.cases, self.sci, self.papers, self.app)[
            0
        ]

    def test_public_and_local_sources_are_distinct_and_bilingual(self):
        for lang, body in self.render().items():
            parsed = Content()
            parsed.feed(body)
            text = "".join(parsed.words)
            self.assertIn(self.sha, text)
            self.assertIn("实验名称", text)
            self.assertIn("x-7", text)
            self.assertIn(
                "Background reading" if lang == "en" else "本周作为背景阅读", text
            )
            self.assertIn(
                "Different electrode." if lang == "en" else "电极不同。", text
            )
            self.assertEqual(parsed.links.count("#case-e1"), 2)
            self.assertIn("https://doi.org/10.1234/S2", parsed.links)
        self.assertIn("Film coverage trial", self.render()["en"])

    def test_changing_the_study_or_its_experiment_fails(self):
        self.papers[1]["abstract"] = "A later version"
        with self.assertRaisesRegex(ValueError, "actual sources"):
            self.render()
        self.papers[1]["abstract"] = self.private["articles"][1]["abstract"]
        self.notes["articles"][1]["uses"] = self.notes["articles"][0]["uses"]
        with self.assertRaisesRegex(ValueError, "attribution"):
            self.render()

    def test_visible_source_digest_is_bound_to_accepted_device_evidence(self):
        self.app["x-7"]["sourceHash"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "digest"):
            self.render()

    def test_title_must_be_approved_and_match_the_private_projection(self):
        self.app["x-7"]["experiment"]["title"] = "restricted name"
        self.assertNotIn("restricted name", self.render()["en"])
        self.notes["caseTitles"][0]["publishRecordedTitle"] = False
        self.app["x-7"]["experiment"]["title"] = "实验名称"
        self.assertNotIn("实验名称", self.render()["en"])

    def test_legacy_sidecar_binds_exact_science_articles_cases_and_reviewed_limits(
        self,
    ):
        del self.sci["literatureNotes"]
        self.write("science-interpretation.json", self.sci)
        base = dict(
            schemaVersion=1,
            classification="UNPUBLISHED_EDITORIAL_SOURCE_NOTES",
            preparedBy="editor",
            interpretationSha256=sha256(
                (self.root / "science-interpretation.json").read_bytes()
            ).hexdigest(),
            caseSources={"E1": self.sha},
            articleRecords={
                a["paper"]: digest({k: a[k] for k in ("doi", "title", "abstract")})
                for a in self.papers
            },
            scientificLimitations=[
                dict(
                    experiment="E1",
                    paper="S1",
                    sha256=sha256(b"Different contact.").hexdigest(),
                )
            ],
            notes=self.notes,
        )
        self.write("literature-editorial-notes.private.json", base)
        self.assertEqual(bound_notes(self.root, self.sci, self.papers), self.notes)
        for key, bad in [
            ("schemaVersion", 2),
            ("interpretationSha256", "0" * 64),
            ("articleRecords", {}),
            ("caseSources", {}),
            ("scientificLimitations", []),
        ]:
            with self.subTest(key=key):
                self.write(
                    "literature-editorial-notes.private.json", {**base, key: bad}
                )
                with self.assertRaises(ValueError):
                    self.render()
