from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

from proposal_revision import (
    FILES,
    PROPOSAL_FIELDS,
    canonical,
    revised_proposal,
    source_revisions,
)


class ProposalRevisionTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.prose = dict(
            en="Measure thickness at matched times.", zh="在相同延时测量膜厚。"
        )
        self.public = {"result": {"en": "Observed efficiency", "zh": "实测效率"}}
        for f in PROPOSAL_FIELDS:
            node = self.public
            keys = f.split(".")
            for part in keys[:-1]:
                node = node.setdefault(part, {})
            node[keys[-1]] = dict(en="Previous proposal", zh="原方案")
        self.case = dict(experiment="E1", sourceHash="9" * 64, public=self.public)
        self.science = dict(cases=[self.case])
        hashes = {}
        for n in (
            "science-interpretation.json",
            "snapshot.json",
            "private-scientific-facts.json",
            "independent-material-science-review.json",
        ):
            hashes[n] = self.write(
                n,
                self.science
                if n.startswith("science-interpretation")
                else {"fixture": n},
            )
        self.challenge = dict(
            challenge="reader-challenge", contentSha256="f" * 64, inputs=hashes
        )
        challengeHash = self.write(FILES[2], self.challenge)
        finding = {
            "severity": "blocking",
            "issue": "test-e1 needs direct thickness measurement",
            "correction": "Propose matched maps",
        }
        val = dict(
            challenge="reader-challenge",
            contentSha256="f" * 64,
            decision="BLOCK",
            sections=[dict(id="test-e1", decision="BLOCK")],
            findings=[finding],
        )
        self.receipt = dict(
            role="final-scientific",
            model="deepseek-v4-pro",
            provider="deepseek",
            providerHost="api.deepseek.com",
            requestId="fixture-request",
            completionId="fixture-response",
            challenge=val["challenge"],
            contentSha256=val["contentSha256"],
            challengeSha256=challengeHash,
            value=val,
            outputHash=canonical(val),
        )
        self.edit = dict(
            schemaVersion=1,
            classification="PROPOSED_VALIDATION_REVISION_PENDING_NEW_FINAL_REVIEW",
            priorInterpretationSha256=hashes["science-interpretation.json"],
            challengeSha256=challengeHash,
            reviewSha256=self.write(FILES[1], self.receipt),
            proposals=[
                dict(
                    experiment="E1",
                    sourceHash=self.case["sourceHash"],
                    originalPublicHash=canonical(self.public),
                    findingSha256=canonical(finding),
                    changes={k: self.prose for k in PROPOSAL_FIELDS},
                )
            ],
        )
        self.write(FILES[0], self.edit)

    def write(self, name, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        (self.root / name).write_bytes(data)
        return sha256(data).hexdigest()

    def test_binds_accepted_data_and_leaves_research_observations_unchanged(self):
        changes = source_revisions(self.root, self.science)
        revised = revised_proposal("E1", self.public, changes)
        self.assertEqual(revised["result"], self.public["result"])
        self.assertEqual(revised["discriminator"], self.prose)
        self.assertNotEqual(self.public["discriminator"], self.prose)

    def test_never_revises_observed_scientific_results(self):
        self.edit["proposals"][0]["changes"]["result"] = self.prose
        self.write(FILES[0], self.edit)
        with self.assertRaisesRegex(ValueError, "read-only"):
            source_revisions(self.root, self.science)

    def test_fails_changed_source_or_origin_receipt(self):
        for f in ("snapshot.json", FILES[1]):
            before = (self.root / f).read_bytes()
            self.write(f, {"changed": 1})
            with self.assertRaisesRegex(ValueError, "not bound"):
                source_revisions(self.root, self.science)
            (self.root / f).write_bytes(before)

    def test_fresh_run_needs_no_supplement_but_partial_lineage_fails(self):
        (self.root / FILES[2]).unlink()
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            source_revisions(self.root, self.science)
        for n in FILES[:2]:
            (self.root / n).unlink()
        self.assertEqual(source_revisions(self.root, self.science), {})
