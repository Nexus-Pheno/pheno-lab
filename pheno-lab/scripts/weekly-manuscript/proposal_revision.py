"""Replay a narrow proposal correction against an authentic, blocked final review."""

from copy import deepcopy
from hashlib import sha256
import json


FILES = (
    "proposal-revision.private.json",
    "proposal-origin-scientific-review.private.json",
    "proposal-origin-challenge.private.json",
)
PROPOSAL_FIELDS = {
    "nextStep",
    "reasoning",
    "alternative",
    "discriminator",
    "criteria",
    *(f"branches.{branch}" for branch in ("positive", "negative", "mixed")),
    *(
        f"signatures.{cause}.{field}"
        for cause in ("preferredCause", "alternativeCause")
        for field in ("quantity", "unit", "expectedChange")
    ),
}


def canonical(value):
    return sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source_revisions(root, science):
    paths = [root / f for f in FILES]
    if not any(p.exists() or p.is_symlink() for p in paths):
        return {}
    require(
        all(
            p.is_file() and not p.is_symlink() and p.stat().st_size < 10_000_000
            for p in paths
        ),
        "Incomplete proposal review lineage",
    )

    def raw(path):
        return sha256(path.read_bytes()).hexdigest()

    edit, review, challenge = [json.loads(p.read_bytes()) for p in paths]
    original_hash = raw(root / "science-interpretation.json")
    require(
        edit["schemaVersion"] == 1
        and edit["classification"]
        == "PROPOSED_VALIDATION_REVISION_PENDING_NEW_FINAL_REVIEW"
        and edit["priorInterpretationSha256"]
        == original_hash
        == challenge["inputs"].get("science-interpretation.json")
        and edit["reviewSha256"] == raw(paths[1])
        and edit["challengeSha256"] == raw(paths[2]) == review["challengeSha256"]
        and all(
            challenge["inputs"].get(n) == raw(root / n)
            for n in (
                "snapshot.json",
                "private-scientific-facts.json",
                "independent-material-science-review.json",
            )
        )
        and challenge["contentSha256"]
        == review["contentSha256"]
        == review["value"]["contentSha256"]
        and challenge["challenge"]
        == review["challenge"]
        == review["value"]["challenge"]
        and review["value"]["decision"] in ("BLOCK", "REVISE")
        and review["role"] == "final-scientific"
        and review["model"] == "deepseek-v4-pro"
        and review["provider"] == "deepseek"
        and review["providerHost"] == "api.deepseek.com"
        and bool(review.get("completionId"))
        and isinstance(review.get("requestId"), str)
        and canonical(review["value"]) == review["outputHash"],
        "Proposal revision is not bound to the reviewed source, manuscript and model response",
    )
    blocks = {s["id"] for s in review["value"]["sections"] if s["decision"] == "BLOCK"}
    findings = {
        canonical(f) for f in review["value"]["findings"] if f["severity"] == "blocking"
    }
    approved = {c["experiment"]: c for c in science["cases"]}
    revisions = {}
    for change in edit["proposals"]:
        k = change["experiment"]
        require(
            k in approved
            and k not in revisions
            and "test-" + k.lower() in blocks
            and change["findingSha256"] in findings
            and ("test-" + k.lower())
            in json.dumps(
                next(
                    f
                    for f in review["value"]["findings"]
                    if canonical(f) == change["findingSha256"]
                )
            ).lower(),
            "Proposal revision lacks a real section-level finding",
        )
        original = approved[k]
        require(
            change["sourceHash"] == original["sourceHash"]
            and change["originalPublicHash"] == canonical(original["public"]),
            "Changed proposal is for different experiment evidence",
        )
        patches = change["changes"]
        require(
            isinstance(patches, dict) and set(patches) == PROPOSAL_FIELDS,
            "Revised design must cover both rivals, their physical units and all three decisions; measurements and existing judgments are read-only",
        )
        for field, value in patches.items():
            require(
                isinstance(value, dict)
                and set(value) == {"en", "zh"}
                and all(
                    isinstance(t, str) and t.strip() and len(t) <= 900
                    for t in value.values()
                ),
                "Missing bilingual validation proposal",
            )
        revisions[k] = patches
    require(bool(revisions), "Empty validation proposal correction")
    return revisions


def revised_proposal(case, display, revisions):
    patches = revisions.get(case)
    if not patches:
        return display
    result = deepcopy(display)
    for path, text in patches.items():
        keys = path.split(".")
        node = result
        for key in keys[:-1]:
            node = node[key]
        require(
            set(node[keys[-1]]) == {"en", "zh"}, "Invalid proposal edit destination"
        )
        node[keys[-1]] = dict(text)
    return result
