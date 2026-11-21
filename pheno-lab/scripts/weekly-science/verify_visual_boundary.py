"""Verify a narrowly adjudicated scroll boundary against frozen screenshots and original reviewer findings."""

from base64 import b64encode
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import sys

SHA = re.compile(r"[a-f0-9]{64}\Z")
MOBILE = re.compile(r"qa/((en|zh)-(320|390)-viewport)\.png\Z")
SANDBOX = "allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"
RUNNER = Path(__file__).resolve().parents[1] / "weekly-runner"
PROVIDER_MODEL = re.compile(r"deepseek-(flash|v4\.1-flash(?:-\d+)?)\Z", re.I)


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(b):
    return sha256(b).hexdigest()


def wire(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def stamp(v):
    t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    need(t.utcoffset() is not None, "Missing boundary review timezone")
    return t


def read(path, limit, artifacts=None, root=None):
    need(
        path.is_file() and path.resolve() == path and path.stat().st_size <= limit,
        "Missing, oversized or redirected viewport evidence",
    )
    data = path.read_bytes()
    if artifacts is not None:
        artifacts[str(path.relative_to(root))] = sha(data)
    return data


def number(n):
    return type(n) in (int, float) and math.isfinite(n)


def rect(box):
    need(
        isinstance(box, dict)
        and set(box) == {"left", "right", "top", "bottom"}
        and all(number(x) for x in box.values())
        and box["left"] < box["right"]
        and box["top"] < box["bottom"],
        "Invalid table/cell rectangle",
    )
    return box


def contains(outer, inner, axes=("left", "right", "top", "bottom")):
    return all(
        inner[k] >= outer[k] - 1 if k in ("left", "top") else inner[k] <= outer[k] + 1
        for k in axes
    )


def shifted(before, after, pan, scroll):
    rect(before)
    rect(after)
    return all(
        abs(before[k] - (pan if k in ("left", "right") else scroll) - after[k]) <= 1
        for k in before
    )


def check_geometry(geometry, refs, language, width, height, verification):
    before = geometry["before"]
    views = geometry["views"]
    checks = geometry["checks"]
    policy = verification["contentSecurityPolicy"]
    need(
        verification["passed"] is True
        and checks
        == dict(
            policySha256=sha(policy.encode()),
            sandbox=SANDBOX,
            cspViolations=0,
            cspConsoleErrors=0,
            externalRequests=0,
        )
        and ("sandbox " + SANDBOX) in policy.split("; ")
        and "connect-src 'none'" in policy.split("; "),
        "Boundary render is outside the approved app policy",
    )
    qa = [
        row
        for row in verification["cases"]
        if row["mode"] == "app-equivalent-csp-sandbox"
        and row["lang"] == language
        and row["width"] == width
    ]
    need(len(qa) == 1 and qa[0]["height"] == height, "Wrong frozen browser viewport")
    need(
        before["lang"] == language
        and (before["width"], before["height"], before["documentWidth"])
        == (width, height, width)
        and before["scrollX"] == before["scrollY"] == 0
        and type(before["documentHeight"]) is int
        and before["documentHeight"] >= height + height // 2
        and type(before["tableIndex"]) is int
        and before["tableIndex"] >= 0
        and before["security"]
        == {"opaqueOrigin": True, "parentAccessBlocked": True, "storageBlocked": True},
        "Wrong original view or report sandbox capabilities",
    )
    tw, cw, left = (
        before["tableWidth"],
        before["tableClientWidth"],
        before["visibleLeft"],
    )
    need(
        type(tw) is int
        and type(cw) is int
        and 0 < cw <= tw
        and number(left)
        and -1 <= left
        and left + cw <= width + 1
        and (tw == cw or before["overflowX"] in ("auto", "scroll")),
        "Unscrollable or clipped table window",
    )
    head, row = rect(before["header"]), rect(before["firstRow"])
    cells = before["cells"]
    n = len(cells) // 2
    need(
        0 < head["top"] < height < head["bottom"]
        and abs(head["bottom"] - row["top"]) <= 1
        and abs(head["left"] - row["left"]) <= 1
        and abs(head["right"] - row["right"]) <= 1
        and 1 <= n <= 100
        and len(cells) == 2 * n,
        "Original view does not contain a table header crossing its lower edge",
    )
    for i, c in enumerate(cells):
        bound = head if i < n else row
        bx, tb = rect(c["box"]), rect(c["textBox"])
        need(
            bool(SHA.fullmatch(c["textSha256"]))
            and contains(bound, bx)
            and contains(bx, tb)
            and abs(bx["top"] - bound["top"]) <= 1
            and abs(bx["bottom"] - bound["bottom"]) <= 1,
            "Unreadable, truncated or misaligned original cell",
        )
        if i % n:
            need(
                abs(cells[i - 1]["box"]["right"] - bx["left"]) <= 1,
                "Original columns overlap or leave a discontinuity",
            )
        if i >= n:
            need(
                all(
                    abs(cells[i - n]["box"][k] - bx[k]) <= 1 for k in ("left", "right")
                ),
                "First data row does not align with its headers",
            )
    pans = [v["panX"] for v in views]
    need(
        len(views) == len(refs)
        and 1 <= len(views) <= 6
        and all(type(p) is int for p in pans)
        and pans == sorted(set(pans))
        and pans[0] == 0
        and pans[-1] == tw - cw,
        "Missing or reordered horizontal continuation",
    )
    visible = set()
    for v, ref in zip(views, refs, strict=True):
        y, x = v["scrollY"], v["panX"]
        need(
            y == height // 2
            and v["scrollX"] == 0
            and (v["width"], v["height"], v["documentWidth"], v["documentHeight"])
            == (width, height, width, before["documentHeight"])
            and v["file"] == ref["file"]
            and v["sha256"] == ref["sha256"]
            and len(v["cells"]) == len(cells),
            "Viewport position, dimensions or continuation image changed",
        )
        need(
            shifted(head, v["header"], x, y)
            and shifted(row, v["firstRow"], x, y)
            and v["header"]["top"] >= 0
            and v["firstRow"]["bottom"] <= height,
            "Full table header and first data row cannot be seen after normal scrolling",
        )
        for i, (old, new) in enumerate(zip(cells, v["cells"], strict=True)):
            need(
                old["textSha256"] == new["textSha256"]
                and shifted(old["box"], new["box"], x, y)
                and shifted(old["textBox"], new["textBox"], x, y),
                "Table text, row order or measured positions changed across the viewport",
            )
            tb = new["textBox"]
            if contains(
                {
                    "left": max(0, left),
                    "right": min(width, left + cw),
                    "top": 0,
                    "bottom": height,
                },
                tb,
            ):
                visible.add(i)
    need(
        len(visible) == len(cells),
        "At least one column's full text is absent from all continuation views",
    )


def eligible_defect(row):
    need(
        row["decision"] == "BLOCK" and len(row["defects"]) == 1,
        "Only one isolated viewport boundary finding is eligible",
    )
    message = row["defects"][0].lower()
    # A positive match is insufficient when the same sentence also reports a second defect.
    vocabulary = set(
        "a an and are as at be because below beyond bottom boundary by can cannot capture captured cell cells clipped clipping column columns content continuation continues cropped cropping cut edge eligible ends extends extending first fold from fully half header headers heading headings horizontal image in incomplete inside into is it its last line lines lower mid middle next not observed of off on only or out outside page partial partially portion read readable reading remainder remaining right row rows screen screenshot scroll scrolling section see seen shown so some split start starts such table tables text than that the their them this to top truncated truncation upper vertical view viewable viewing viewport visibility visible visually was were where which width window within without would".split()
    )
    words = re.findall("[a-z]+", message.replace("’s", "").replace("'s", ""))
    need(
        all(t in vocabulary for t in words)
        and re.search(r"\b(viewport|screen|bottom|scrolling)\b", message)
        and re.search(r"\b(table|row|headers?|columns?|cells?)\b", message)
        and re.search(
            r"clip|cut\s*off|\bcut\b|truncat|partial|half|outside|beyond|crop|split",
            message,
        ),
        "Original review names an additional defect or is not a pure scroll-boundary finding",
    )


def png(path, digest, width, artifacts, root):
    data = read(path, 30 * 1024 * 1024, artifacts, root)
    need(
        sha(data) == digest
        and data[:8] == b"\x89PNG\r\n\x1a\n"
        and data[12:16] == b"IHDR"
        and len(data) > 24,
        "Changed or invalid viewport PNG",
    )
    w, h = struct.unpack(">II", data[16:24])
    need(w == width and 300 <= h <= 1600, "Incorrect screenshot dimensions")
    return data, h


def request_digest(token, original, views, page):
    system = json.loads(read(RUNNER / "vision-boundary-prompt.json", 24000))
    image = lambda b: {
        "type": "image_url",
        "image_url": {
            "url": "data:image/png;base64," + b64encode(b).decode(),
            "detail": "original",
        },
    }
    calibration = subprocess.run(
        [sys.executable, "-B", str(RUNNER / "canary.py"), token],
        capture_output=True,
        check=True,
        timeout=20,
    ).stdout
    message = {
        "finding": page["defects"],
        "observation": page["observation"],
        "order": [
            "calibration",
            "original viewport",
            "overlapping continuation",
            *[f"horizontal continuation {i}" for i in range(1, len(views))],
        ],
    }
    return sha(
        wire(
            {
                "model": "deepseek-flash",
                "stream": False,
                "max_tokens": 2600,
                "thinking": {"type": "disabled"},
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": wire(message)},
                            image(calibration),
                            image(original),
                            *[image(x) for x in views],
                        ],
                    },
                ],
            }
        ).encode()
    )


def verify_boundaries(
    gate,
    reviews,
    challenge,
    visual,
    blocked,
    used_ids,
    used_requests,
    used_responses,
    used_canaries,
):
    """All original blocking rows stay frozen. Accept only independently resolved normal scrolling."""
    try:
        return _verify(
            gate,
            reviews,
            challenge,
            visual,
            blocked,
            set(used_ids),
            set(used_requests),
            set(used_responses),
            set(used_canaries),
        )
    except (
        KeyError,
        IndexError,
        TypeError,
        AttributeError,
        ValueError,
        OSError,
        subprocess.SubprocessError,
    ) as exc:
        raise ValueError("Viewport-boundary adjudication failed: " + str(exc)) from exc


def _verify(gate, reviews, ch, visual, blocked, ids, requests, responses, canaries):
    gate, reviews = Path(gate), Path(reviews)
    root = gate.parent
    need(
        reviews.parent == root
        and gate.resolve() == gate
        and reviews.resolve() == reviews,
        "Invalid independent review directory",
    )
    artifacts = {}
    extra = set()
    readj = lambda p, maxsize=2_000_000: json.loads(read(p, maxsize, artifacts, root))
    ch_data = read(gate / "challenge.json", 8_000_000)
    ch_hash = sha(ch_data)
    need(
        ch == json.loads(ch_data)
        and ch["schemaVersion"] == 1
        and SHA.fullmatch(ch["challenge"])
        and SHA.fullmatch(ch["contentSha256"]),
        "Mismatch with original final review challenge",
    )
    verification = readj(gate / "qa/verification.json", 8_000_000)
    need(
        artifacts[str((gate / "qa/verification.json").relative_to(root))]
        == ch["outputs"]["qa/verification.json"],
        "Original browser policy record was modified",
    )
    inventory = ch["images"]
    names = [i["file"] for i in inventory]
    need(
        len(names) == len(set(names))
        and len(visual["batches"]) == (len(names) + 2) // 3
        and visual["challenge"] == ch["challenge"]
        and visual["challengeSha256"] == ch_hash
        and visual["contentSha256"] == ch["contentSha256"],
        "Final visual review differs from original inventory",
    )
    original_rows = {}
    findings_rows = []
    origins = {}
    starts = {}
    for i, batch in enumerate(visual["batches"]):
        start = 3 * i
        name = f"vision-clarification-{start}.json"
        if not (reviews / name).exists():
            name = f"vision-batch-{start}.json"
        original = readj(reviews / name)
        need(
            original == batch
            and original["challengeSha256"] == ch_hash
            and len(original["images"]) == len(inventory[start : start + 3]),
            "Unpreserved or changed original batch",
        )
        for j, (im, row) in enumerate(
            zip(inventory[start : start + 3], original["images"], strict=True)
        ):
            need(
                row["index"] == j + 1
                and row["file"] == im["file"]
                and row["sha256"] == im["sha256"]
                and (
                    row["decision"] == "BLOCK"
                    or (row["decision"] == "PASS" and row["defects"] == [])
                ),
                "Original visual inventory, image order or verdict was edited",
            )
            if row["decision"] == "BLOCK":
                eligible_defect(row)
                original_rows[im["file"]] = row
                origins[im["file"]] = original
                starts[im["file"]] = name
                findings_rows.append(
                    dict(
                        row,
                        **{
                            k: original[k]
                            for k in ("requestHash", "responseHash", "responseId")
                        },
                    )
                )
    summary = readj(reviews / "visual-findings.json")
    need(
        original_rows
        and blocked == original_rows
        and summary
        == {
            "schemaVersion": 1,
            "decision": "BLOCK",
            "challenge": ch["challenge"],
            "challengeSha256": ch_hash,
            "contentSha256": ch["contentSha256"],
            "inspectedImages": len(names),
            "blocked": findings_rows,
        }
        and set(visual["boundaryAdjudications"]) == set(blocked),
        "Unaccounted or overwritten original visual finding",
    )
    # Include all prior role identifiers; the resolving reviewer must be a distinct completion.
    ids.update(ch.get("priorStageCompletionIds", []))
    for batch in visual["batches"]:
        ids.add(batch["responseId"])
        requests.add(batch["requestHash"])
        responses.add(batch["responseHash"])
        canaries.add(batch["canaryExpected"])
    for name, page in original_rows.items():
        m = MOBILE.fullmatch(name)
        need(bool(m), "Only an original mobile viewport may use scroll continuation")
        stem, lang, width = m[1], m[2], int(m[3])
        path = lambda prefix: reviews / (prefix + stem + ".json")
        evidence = readj(path("boundary-evidence-"))
        att = readj(path("boundary-attempt-"))
        receipt = readj(path("boundary-review-"))
        response = readj(path("boundary-response-"))
        hashfile = lambda p: artifacts[str(p.relative_to(root))]
        need(
            visual["boundaryAdjudications"][name]
            == dict(
                evidenceSha256=hashfile(path("boundary-evidence-")),
                reviewSha256=hashfile(path("boundary-review-")),
            ),
            "Unbound independent adjudication receipt or evidence",
        )
        original_spec = dict(file=name, sha256=page["sha256"])
        need(
            evidence["schemaVersion"] == 1
            and evidence["original"] == original_spec
            and evidence["challengeSha256"] == ch_hash
            and evidence["contentSha256"] == ch["contentSha256"],
            "Wrong frozen report or original image",
        )
        refs = [evidence["continuation"], *evidence["horizontalViews"]]
        check_names = [
            f"boundary-{stem}-continuation.png",
            *[f"boundary-{stem}-pan-{j}.png" for j in range(1, len(refs))],
        ]
        need(
            [a["file"] for a in refs] == check_names
            and len({v["sha256"] for v in [original_spec, *refs]}) == len(refs) + 1,
            "Image repeated, missing or wrong continuation order",
        )
        data, height = png(gate / name, page["sha256"], width, artifacts, root)
        views = []
        for ref in refs:
            b, h = png(reviews / ref["file"], ref["sha256"], width, artifacts, root)
            need(h == height, "Changed continuation height")
            views.append(b)
        check_geometry(evidence["geometry"], refs, lang, width, height, verification)
        token = att["canaryExpected"]
        need(
            isinstance(token, str)
            and re.fullmatch(r"[0-9]{6}", token)
            and token not in canaries,
            "Duplicate independence calibration",
        )
        req = request_digest(token, data, views, page)
        expected = dict(
            schemaVersion=1,
            role="viewport-boundary",
            model="deepseek-flash",
            providerHost="api.deepseek.com",
            challengeSha256=ch_hash,
            contentSha256=ch["contentSha256"],
            evidenceSha256=hashfile(path("boundary-evidence-")),
            originalBatchSha256=hashfile(reviews / starts[name]),
            originalResponseId=origins[name]["responseId"],
            originalFile=name,
            originalSha256=page["sha256"],
            continuationSha256=refs[0]["sha256"],
            horizontalViews=refs[1:],
            canaryExpected=token,
            requestHash=req,
        )
        need(
            att == expected
            and req not in requests
            and {k: receipt.get(k) for k in att} == att,
            "Viewport resolving request or original provider finding differs",
        )
        rid = response["id"]
        res = hashfile(path("boundary-response-"))
        need(
            isinstance(rid, str)
            and len(rid) >= 5
            and rid not in ids
            and res not in responses
            and receipt["responseHash"] == res
            and receipt["responseId"] == rid
            and receipt["modelReturned"] == response["model"]
            and PROVIDER_MODEL.fullmatch(response["model"])
            and len(response["choices"]) == 1
            and response["choices"][0]["finish_reason"] == "stop",
            "Reused or incomplete independent provider completion",
        )
        result = json.loads(response["choices"][0]["message"]["content"])
        got = result.pop("canary")
        need(
            got == token == receipt["canaryReceived"]
            and result == receipt["result"]
            and result["classification"] == "NORMAL_VIEWPORT_CONTINUATION"
            and result["defects"] == []
            and all(
                isinstance(result.get(k), str) and 20 <= len(result[k].strip()) <= 1500
                for k in (
                    "originalObservation",
                    "continuationObservation",
                    "continuity",
                    "assessment",
                )
            ),
            "Independent reviewer did not resolve the original defect",
        )
        need(
            stamp(ch["createdAt"])
            <= stamp(receipt["completedAt"])
            <= datetime.now(timezone.utc) + timedelta(minutes=1),
            "Independent viewport review predates its challenge",
        )
        extra.add(rid)
        ids.add(rid)
        responses.add(res)
        requests.add(req)
        canaries.add(token)
    return extra, artifacts
