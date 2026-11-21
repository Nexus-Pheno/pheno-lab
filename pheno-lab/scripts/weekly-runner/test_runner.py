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
