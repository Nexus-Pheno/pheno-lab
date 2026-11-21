import datetime as dt
import hashlib
import json
import tempfile
from pathlib import Path
from unittest import TestCase, main, mock
import run as runner


class WeeklyScheduleTests(TestCase):
    def test_missed_fire_uses_last_due_shanghai_saturday(self):
        def slot(ts):
            return runner.key_for(runner.due(dt.datetime.fromisoformat(ts)))

        self.assertEqual(
            slot("2026-11-28T00:59:59+00:00"), "materials-process-weekly-2026-11-21-v1"
        )
        self.assertEqual(
            slot("2026-11-28T01:00:00+00:00"), "materials-process-weekly-2026-11-28-v1"
        )
        self.assertEqual(
            slot("2026-11-30T01:00:00+00:00"), "materials-process-weekly-2026-11-28-v1"
        )

    def test_freeze_idempotent_and_refuses_changed_content(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "input"
            runner.write(target, {"x": 1})
            original = target.read_bytes()
            runner.write(target, {"x": 1})
            with self.assertRaises(ValueError):
                runner.write(target, {"x": 2})
            self.assertEqual(original, target.read_bytes())

    def test_replay_never_delivers_even_if_inspection_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "acceptance").mkdir()
            (root / "history").mkdir()
            (root / "history/run-result.json").write_text(
                json.dumps({"publicationKey": "historic-record"})
            )
            with (
                mock.patch(
                    "sys.argv",
                    [
                        "run",
                        "replay",
                        "--state",
                        folder,
                        "--frozen",
                        str(root / "history"),
                        "--prior",
                        str(root / "earlier"),
                    ],
                ),
                mock.patch.object(
                    runner,
                    "inspect",
                    side_effect=[
                        {"status": "PUBLISHED", "id": 1},
                        {"status": "PUBLISHED", "id": 2},
                    ],
                ),
                mock.patch.object(runner, "run"),
                mock.patch.object(runner, "deliver") as deliver,
            ):
                with self.assertRaises(ValueError):
                    runner.main()
                deliver.assert_not_called()

    def test_partial_source_is_never_visible_to_a_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "snapshot.json"
            with self.assertRaises(InterruptedError):
                with runner.staged_output(target) as staged:
                    staged.write_text("partial")
                    raise InterruptedError()
            self.assertFalse(target.exists())
            with runner.staged_output(target) as staged:
                staged.write_text("complete")
            with self.assertRaises(FileExistsError):
                with runner.staged_output(target) as staged:
                    staged.write_text("different")
            self.assertEqual(target.read_text(), "complete")

    def test_earlier_unarchived_delivery_is_reconciled_before_new_collection(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            earlier = state / "work/materials-process-weekly-2026-11-21-v1"
            earlier.mkdir(parents=True)
            (earlier / "publication-envelope.json").write_text("{}")
            later = "materials-process-weekly-2026-11-28-v1"
            with (
                mock.patch.object(
                    runner,
                    "inspect",
                    side_effect=[{"status": "ABSENT"}, {"status": "PUBLISHED"}],
                ),
                mock.patch.object(runner, "finish") as finish,
                mock.patch.object(runner, "deliver") as publish,
            ):
                with self.assertRaisesRegex(ValueError, "earlier frozen delivery"):
                    runner.recover_prior_publications(state, later)
                finish.assert_not_called()
                runner.recover_prior_publications(state, later)
                finish.assert_called_once_with(state, earlier, {"status": "PUBLISHED"})
                publish.assert_not_called()

    def test_reanalysis_preserves_notices_even_when_a_draft_is_rejected(self):
        import sys

        sys.path.insert(0, str(runner.SCI))
        import replay_frozen_report

        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            archive, prior = state / "historic", state / "prior"
            for p in (archive, prior, state / "acceptance"):
                p.mkdir(mode=0o700)
            (archive / "snapshot.json").write_bytes(b"actual frozen input")
            key = "materials-process-weekly-2026-11-21-v1"
            original = dict(
                publicationKey=key,
                reportId="original",
                contentSha256="content",
                priorReportId="prior",
                snapshotSha256=hashlib.sha256(b"actual frozen input").hexdigest(),
            )
            base = dict(
                reportId="prior",
                snapshotSha256="source",
                dossierPublishedSha256="ledger",
            )
            before = dict(
                status="PUBLISHED",
                reportId="original",
                contentSha256="content",
                noticeIds=list("abcde"),
            )
            with (
                mock.patch.object(
                    replay_frozen_report,
                    "check_published_run",
                    side_effect=[original, base],
                ),
                mock.patch.object(
                    runner, "inspect", side_effect=[before, before]
                ) as inspect,
                mock.patch.object(
                    runner, "prepare_dossier", side_effect=ValueError("draft rejected")
                ),
                mock.patch.object(runner, "deliver") as publish,
            ):
                with self.assertRaisesRegex(ValueError, "draft rejected"):
                    runner.rehearse(state, archive, prior, None)
                self.assertEqual(inspect.call_count, 2)
                publish.assert_not_called()
            self.assertFalse(
                (
                    state
                    / "acceptance"
                    / ("reanalysis-" + key)
                    / "rehearsal-result.json"
                ).exists()
            )

    def test_changed_source_or_peer_receipt_blocks_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            gate, reviews = work / "gate", work / "reviews"
            (gate / "approved").mkdir(parents=True)
            reviews.mkdir()

            def artifact(path):
                path.write_text(path.name)
                return hashlib.sha256(path.read_bytes()).hexdigest()

            sources = {"snapshot.json": artifact(work / "snapshot.json")}
            peers = {
                n: artifact(reviews / n)
                for n in ("scientific-review.json", "visual-review.json")
            }
            ch = {"inputs": sources, "contentSha256": "html"}
            runner.write(gate / "challenge.json", ch)
            runner.write(
                gate / "ready.json",
                dict(
                    status="READY_FOR_AUTHORIZED_PUBLICATION",
                    passed=True,
                    publicationPerformed=False,
                    contentSha256="html",
                    verifiedArtifactHashes=sources,
                    reviewHashes=peers,
                    signedDocumentSha256=artifact(
                        gate / "report-document-reviewed.json"
                    ),
                    finalGatesSha256=artifact(gate / "approved/gates.json"),
                    challengeSha256=hashlib.sha256(
                        (gate / "challenge.json").read_bytes()
                    ).hexdigest(),
                ),
            )
            self.assertTrue(runner.verify_delivery_files(work)["passed"])
            for path in [
                work / "snapshot.json",
                reviews / "scientific-review.json",
                gate / "approved/gates.json",
            ]:
                original = path.read_bytes()
                path.write_text("changed")
                with self.subTest(path=path.name), self.assertRaises(ValueError):
                    runner.verify_delivery_files(work)
                path.write_bytes(original)

    def test_trace_matches_only_shared_route_and_keeps_unmeasured_dispersion(self):
        from envelopes import route_panels, section

        def cohort(period, mean, route):
            extremes = {
                k: {"pce": mean}
                for k in ("championValidScan", "bestPhysicalSampleMedian")
            }
            metrics = {
                "nSamples": 1,
                "mean": mean,
                "median": mean,
                "sampleStandardDeviation": None,
                "iqr": 0,
            }
            return dict(
                view="TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL",
                periodCohort=period,
                routeId=route,
                routeCohortId=route + ":" + period,
                direction="REVERSE",
                group="Control",
                experimentCode="S-1",
                evidenceTier="SOURCE_LINKED_INSTRUMENT_SCAN",
                pceExtremes=extremes,
                inferenceOutcomes={
                    "nScans": 1,
                    "nSamples": 1,
                    "metrics": {"pce": metrics},
                },
            )

        rows = [
            cohort("CURRENT_PERIOD", 20, "r"),
            cohort("PREVIOUS_EQUAL_DURATION_PERIOD", 19, "r"),
            cohort("PREVIOUS_EQUAL_DURATION_PERIOD", 25, "different"),
        ]

        def panels(items):
            return route_panels(
                {"projectAlias": "p", "periodPerformance": {"routeCohorts": items}},
                section("x", "EN", "ZH"),
                {
                    "confidence": "LOW",
                    "alias": "p",
                    "decision": "ADJUST",
                    "reason": {"en": "Inspect data.", "zh": "核对数据。"},
                },
                ["S-1"],
            )

        pair = panels(rows)["longitudinalJudgment"]["pairs"][0]
        self.assertEqual(
            pair["differencesCurrentMinusReference"]["meanSampleMedianPce"], 1
        )
        self.assertIsNone(pair["differencesCurrentMinusReference"]["sdSampleMedianPce"])
        self.assertEqual(pair["referenceCohortId"], "r:PREVIOUS_EQUAL_DURATION_PERIOD")
        self.assertEqual(
            panels([rows[0], rows[2]])["longitudinalJudgment"]["pairs"], []
        )

    def test_group_facts_and_charts_only_cover_reviewed_measured_arms(self):
        from envelopes import comparisons, pce_figure

        stats = {"n": 2, "mean": 12.1, "best": 12.4, "sd": 0.4}
        groups = [
            {
                "label": label,
                "metrics": {"pce": numbers},
                "judgment": "exploratory",
                "evidenceConfidence": "limited",
            }
            for label, numbers in [
                ("Test", stats),
                ("Empty", {**stats, "n": 0, "mean": None, "best": None}),
                ("Unreviewed", stats),
            ]
        ]
        char = {"id": "one", "groups": groups}
        reviewed = ["Test", "Empty"]
        self.assertEqual(
            [
                r["group"]
                for r in comparisons({"characterizations": [char]}, "one", reviewed)
            ],
            reviewed,
        )
        svg = pce_figure(char, reviewed, "zh")
        self.assertIn(">Test</text>", svg)
        self.assertNotIn(">Empty</text>", svg)
        self.assertNotIn("Unreviewed", svg)

    def test_cannot_reconcile_a_changed_report(self):
        env = dict(
            organizationId="org",
            recipientIds=["r"],
            titleEn="Example",
            titleZh="示例",
            generatedAt="2026-11-21",
            publicationKey="example-key",
            html="body",
        )
        receipt = {
            **env,
            "status": "PUBLISHED",
            "contentBytes": 4,
            "contentSha256": hashlib.sha256(b"body").hexdigest(),
        }
        runner.validate_receipt(receipt, env)
        for k, v in [
            ("contentSha256", "other"),
            ("recipientIds", ["x"]),
            ("titleEn", "Different"),
        ]:
            with self.subTest(k=k), self.assertRaises(ValueError):
                runner.validate_receipt({**receipt, k: v}, env)


if __name__ == "__main__":
    main()
