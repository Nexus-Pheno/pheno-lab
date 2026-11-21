"""Synthetic geometry plus bypass tests for a narrowly eligible scroll-boundary decision."""

from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from verify_visual_boundary import (
    SANDBOX,
    check_geometry,
    eligible_defect,
    request_digest,
    sha,
    verify_boundaries,
    wire,
)


def box(l, r, t, b):
    return {"left": l, "right": r, "top": t, "bottom": b}


def shift(b, pan, dy):
    return {k: v - (pan if k in ("left", "right") else dy) for k, v in b.items()}


def png(w, h, seed):
    def chunk(tag, b):
        return (
            struct.pack(">I", len(b)) + tag + b + struct.pack(">I", zlib.crc32(tag + b))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\x00" + bytes([seed]) * w) * h))
        + chunk(b"IEND", b"")
    )


def geometry(refs):
    half = 320
    head = box(10, 490, 560, 690)
    row = box(10, 490, 690, 790)
    cells = []
    for j, b in enumerate([head, row]):
        for i in range(2):
            l = i * 240 + 10
            cells.append(
                {
                    "box": box(l, l + 240, b["top"], b["bottom"]),
                    "textBox": box(l + 12, l + 228, b["top"] + 8, b["bottom"] - 8),
                    "textSha256": sha(f"{i}-{j}".encode()),
                }
            )
    before = dict(
        lang="zh",
        width=320,
        height=640,
        documentWidth=320,
        documentHeight=2500,
        scrollX=0,
        scrollY=0,
        tableWidth=480,
        tableClientWidth=300,
        tableIndex=0,
        visibleLeft=10,
        overflowX="auto",
        header=head,
        firstRow=row,
        cells=cells,
        security=dict(opaqueOrigin=True, parentAccessBlocked=True, storageBlocked=True),
    )
    views = []
    for ref, pan in zip(refs, [0, 180], strict=True):
        views.append(
            dict(
                ref,
                scrollX=0,
                scrollY=half,
                panX=pan,
                width=320,
                height=640,
                documentWidth=320,
                documentHeight=2500,
                header=shift(head, pan, half),
                firstRow=shift(row, pan, half),
                cells=[
                    {
                        "box": shift(c["box"], pan, half),
                        "textBox": shift(c["textBox"], pan, half),
                        "textSha256": c["textSha256"],
                    }
                    for c in cells
                ],
            )
        )
    policy = "default-src 'none'; connect-src 'none'; sandbox " + SANDBOX
    checks = dict(
        policySha256=sha(policy.encode()),
        sandbox=SANDBOX,
        cspConsoleErrors=0,
        cspViolations=0,
        externalRequests=0,
    )
    verification = dict(
        passed=True,
        contentSecurityPolicy=policy,
        cases=[
            dict(mode="app-equivalent-csp-sandbox", lang="zh", width=320, height=640)
        ],
    )
    return dict(before=before, views=views, checks=checks), verification


class BoundaryGeometry(unittest.TestCase):
    def setUp(self):
        self.refs = [dict(file="a", sha256="a" * 64), dict(file="b", sha256="b" * 64)]
        self.g, self.qa = geometry(self.refs)

    def check(self):
        check_geometry(self.g, self.refs, "zh", 320, 640, self.qa)

    def test_last_header_is_readable_by_normal_scroll_and_pan(self):
        self.check()

    def test_changed_row_text_or_coordinates_are_rejected(self):
        self.g["views"][0]["cells"][1]["textSha256"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "text, row order"):
            self.check()
        self.setUp()
        self.g["views"][0]["cells"][1]["box"]["top"] += 3
        with self.assertRaisesRegex(ValueError, "text, row order"):
            self.check()

    def test_still_missing_rightmost_text_is_not_a_pass(self):
        self.g["views"].pop()
        self.refs.pop()
        with self.assertRaisesRegex(ValueError, "horizontal continuation"):
            self.check()

    def test_even_at_maximum_pan_every_text_rectangle_must_fit(self):
        c = self.g["before"]["cells"][0]
        c["box"]["right"] = 330
        c["textBox"]["right"] = 326
        for i in (0, 1):
            for j in (0, 2):
                old = self.g["before"]["cells"][j]
                old["box"]["right"] = 330
                old["textBox"]["right"] = 326
                self.g["before"]["cells"][j + 1]["box"]["left"] = 330
                self.g["before"]["cells"][j + 1]["textBox"]["left"] = 335
            p = self.g["views"][i]["panX"]
            self.g["views"][i]["cells"] = [
                {
                    "box": shift(t["box"], p, 320),
                    "textBox": shift(t["textBox"], p, 320),
                    "textSha256": t["textSha256"],
                }
                for t in self.g["before"]["cells"]
            ]
        with self.assertRaisesRegex(ValueError, "absent from all"):
            self.check()

    def test_all_cells_have_to_be_inside_the_row_and_browser_policy(self):
        self.g["before"]["cells"][2]["textBox"]["top"] -= 100
        with self.assertRaisesRegex(ValueError, "truncated"):
            self.check()
        self.setUp()
        self.g["checks"]["externalRequests"] = 1
        with self.assertRaisesRegex(ValueError, "policy"):
            self.check()

    def test_nonboundary_originals_and_hidden_horizontal_overflow_stay_blocked(self):
        self.g["before"]["header"]["bottom"] = 640
        with self.assertRaisesRegex(ValueError, "lower edge"):
            self.check()
        self.setUp()
        self.g["before"]["overflowX"] = "hidden"
        with self.assertRaisesRegex(ValueError, "Unscrollable"):
            self.check()

    def test_other_or_compound_defects_cannot_be_adjudicated_as_normal_scrolling(self):
        for ds in (
            ["Header cut by bottom of viewport and the plot legend is absent."],
            ["Black block hides table data."],
            ["Header cut off at viewport", "Other row overlaps."],
        ):
            with self.subTest(ds=ds), self.assertRaises(ValueError):
                eligible_defect(dict(decision="BLOCK", defects=ds))


class BoundaryReceipt(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.r = Path(temp.name).resolve()
        self.gate = self.r / "gate"
        self.reviews = self.r / "reviews"
        qa = self.gate / "qa"
        qa.mkdir(parents=True)
        self.reviews.mkdir()
        self.stem = "zh-320-viewport"
        name = f"qa/{self.stem}.png"
        self.name = name
        data = [png(320, 640, i + 1) for i in range(3)]
        (self.gate / name).write_bytes(data[0])
        refs = []
        for suffix, d in zip(("continuation", "pan-1"), data[1:], strict=True):
            fn = f"boundary-{self.stem}-{suffix}.png"
            (self.reviews / fn).write_bytes(d)
            refs.append(dict(file=fn, sha256=sha(d)))
        geo, qa_json = geometry(refs)
        qhash = self.save(qa / "verification.json", qa_json)
        now = datetime.now(timezone.utc)
        self.ch = dict(
            schemaVersion=1,
            challenge="1" * 64,
            contentSha256="2" * 64,
            outputs={"qa/verification.json": qhash},
            images=[dict(file=name, sha256=sha(data[0]))],
            createdAt=(now - timedelta(seconds=2)).isoformat(),
        )
        chhash = self.save(self.gate / "challenge.json", self.ch)
        page = dict(
            index=1,
            **self.ch["images"][0],
            advisories=[],
            decision="BLOCK",
            observation="The visible header continues along the lower edge of this screen.",
            defects=["The bottom table header is cut off by the viewport."],
        )
        batch = dict(
            requestHash="3" * 64,
            responseHash="4" * 64,
            responseId="original-response",
            modelReturned="deepseek-flash",
            canaryExpected="101010",
            canaryReceived="101010",
            challengeSha256=chhash,
            images=[page],
        )
        bh = self.save(self.reviews / "vision-batch-0.json", batch)
        self.blocked = {name: page}
        origin = dict(
            page, **{k: batch[k] for k in ("requestHash", "responseHash", "responseId")}
        )
        self.save(
            self.reviews / "visual-findings.json",
            dict(
                schemaVersion=1,
                decision="BLOCK",
                challenge=self.ch["challenge"],
                challengeSha256=chhash,
                contentSha256=self.ch["contentSha256"],
                inspectedImages=1,
                blocked=[origin],
            ),
        )
        ev = dict(
            schemaVersion=1,
            challengeSha256=chhash,
            contentSha256=self.ch["contentSha256"],
            original=self.ch["images"][0],
            continuation=refs[0],
            horizontalViews=refs[1:],
            geometry=geo,
        )
        eh = self.save(self.path("evidence"), ev)
        token = "203040"
        request = request_digest(token, data[0], data[1:], page)
        base = dict(
            schemaVersion=1,
            role="viewport-boundary",
            challengeSha256=chhash,
            contentSha256=self.ch["contentSha256"],
            evidenceSha256=eh,
            originalBatchSha256=bh,
            originalResponseId=batch["responseId"],
            originalFile=name,
            originalSha256=sha(data[0]),
            continuationSha256=refs[0]["sha256"],
            horizontalViews=refs[1:],
            model="deepseek-flash",
            providerHost="api.deepseek.com",
            requestHash=request,
            canaryExpected=token,
        )
        self.save(self.path("attempt"), base)
        result = dict(
            classification="NORMAL_VIEWPORT_CONTINUATION",
            originalObservation="The original image ends halfway down the table heading.",
            continuationObservation="Both column headings and the first data row are visible.",
            continuity="The rightmost cells are now visible after the horizontal pan.",
            assessment="No missing cells remain after scrolling through the two views.",
            defects=[],
        )
        resp = dict(
            id="new-response",
            model="deepseek-v4.1-flash",
            choices=[
                {
                    "finish_reason": "stop",
                    "message": {"content": wire(dict(canary=token, **result))},
                }
            ],
        )
        rh = self.save(self.path("response"), resp)
        self.receipt = dict(
            base,
            modelReturned=resp["model"],
            responseId=resp["id"],
            responseHash=rh,
            canaryReceived=token,
            completedAt=now.isoformat(),
            result=result,
        )
        cert = self.save(self.path("review"), self.receipt)
        self.visual = dict(
            challenge=self.ch["challenge"],
            contentSha256=self.ch["contentSha256"],
            challengeSha256=chhash,
            batches=[batch],
            boundaryAdjudications={name: dict(reviewSha256=cert, evidenceSha256=eh)},
        )

    def path(self, s):
        return self.reviews / f"boundary-{s}-{self.stem}.json"

    def save(self, p, v):
        data = wire(v).encode()
        p.write_bytes(data)
        return sha(data)

    def check(self, ids=(), reqs=(), resps=(), canaries=()):
        return verify_boundaries(
            self.gate,
            self.reviews,
            self.ch,
            self.visual,
            self.blocked,
            ids,
            reqs,
            resps,
            canaries,
        )

    def test_verified_images_raw_responses_and_original_failure_are_sealed(self):
        ids, artifacts = self.check()
        self.assertEqual(ids, {"new-response"})
        for f in (
            "visual-findings.json",
            "vision-batch-0.json",
            self.path("evidence").name,
            self.path("response").name,
            self.path("attempt").name,
        ):
            self.assertIn("reviews/" + f, artifacts)

    def test_changed_canary_completed_call_or_request_fails(self):
        for args in [
            ({"new-response"}, (), (), ()),
            ((), {self.receipt["requestHash"]}, (), ()),
            ((), (), {self.receipt["responseHash"]}, ()),
            ((), (), (), {"203040"}),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.check(*args)

    def test_omitting_original_finding_or_resolving_an_unseen_file_fails(self):
        self.visual["boundaryAdjudications"] = {}
        with self.assertRaisesRegex(ValueError, "Unaccounted"):
            self.check()

    def test_provider_verdict_must_match_the_actual_raw_response(self):
        self.receipt["result"]["classification"] = "INDETERMINATE"
        self.visual["boundaryAdjudications"][self.name]["reviewSha256"] = self.save(
            self.path("review"), self.receipt
        )
        with self.assertRaisesRegex(ValueError, "did not resolve"):
            self.check()

    def test_changed_screenshot_is_rejected_even_if_label_and_dimensions_match(self):
        (self.reviews / f"boundary-{self.stem}-pan-1.png").write_bytes(
            png(320, 640, 50)
        )
        with self.assertRaisesRegex(ValueError, "viewport PNG"):
            self.check()

    def test_a_replaced_original_review_batch_cannot_be_overruled(self):
        path = self.reviews / "vision-batch-0.json"
        batch = json.loads(path.read_bytes())
        batch["images"][0]["decision"] = "PASS"
        self.save(path, batch)
        with self.assertRaisesRegex(ValueError, "changed original batch"):
            self.check()
