"""Bind independent scientific review to a bilingual draft and private annex."""

import argparse
import datetime as dt
import hashlib
import json
import re
from html import escape
from pathlib import Path

from prepare import read, save


def canonical(value):
    # Manuscript objects contain strings, arrays and null only; matches the TS canonical hash.
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode()
    ).hexdigest()


def paragraph(value):
    return "<p>" + escape(value) + "</p>"


def table(headers, rows):
    head = (
        "<thead><tr>"
        + "".join("<th>" + escape(x) + "</th>" for x in headers)
        + "</tr></thead>"
    )
    body = (
        "<tbody>"
        + "".join(
            "<tr>" + "".join("<td>" + escape(str(x)) + "</td>" for x in row) + "</tr>"
            for row in rows
        )
        + "</tbody>"
    )
    return "<table>" + head + body + "</table>"


def subsection(title, text):
    return "<h3>" + escape(title) + "</h3>" + paragraph(text)


def section(key, en, zh, body):
    return {
        "id": key,
        "titleEn": en,
        "titleZh": zh,
        "bodyEn": body["en"],
        "bodyZh": body["zh"],
    }


PROJECT_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])P[1-9][0-9]*(?![A-Za-z0-9_-])")
SOURCE_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])(?:[0-9a-fA-F]{20,}|(?:period-route|route-cohort|stratum|cohort)-[A-Za-z0-9-]{9,})(?![A-Za-z0-9])"
)


def display_project_text(value, names):
    """Substitute local project names only in bilingual prose. Keep linked IDs intact."""
    if isinstance(value, list):
        return [display_project_text(row, names) for row in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, text in value.items():
        if key in ("en", "zh") and isinstance(text, str):
            if SOURCE_TOKEN.search(text):
                raise ValueError(
                    "Scientific project prose exposes an internal source identifier"
                )

            def project_name(match, language=key):
                p = match.group()
                if p not in names:
                    raise ValueError(
                        "Scientific project prose uses an unresolved project identifier"
                    )
                return names[p]["name"] or (
                    "未分配项目" if language == "zh" else "Unassigned experiments"
                )

            result[key] = PROJECT_TOKEN.sub(project_name, text)
        else:
            result[key] = display_project_text(text, names)
    return result


def spell_out_uv_test(value):
    # In these explicitly optical test phrases UV names ultraviolet exposure.
    # Other tokens, identifiers, chemical names and candidate formulas are retained.
    return re.sub(
        r"\bUV(?=\s+(?:(?:and|or)\s+(?:light[ -]heat|thermal|heat)\s+)?"
        r"(?:ag(?:ing|eing)|exposure|illumination|irradiation|soak|stability|photodegradation)\b)",
        "ultraviolet",
        value,
        flags=re.IGNORECASE,
    )


def digest(path):
    with path.open("rb") as stream:
        return (
            hashlib.file_digest(stream, "sha256").hexdigest()
            if hasattr(hashlib, "file_digest")
            else hashlib.sha256(stream.read()).hexdigest()
        )


def assemble_science(root):
    scientific = read(root / "science-interpretation.json")
    peer = read(root / "independent-material-science-review.json")
    if (
        peer["value"]["decision"] != "PASS"
        or peer["bindingFailure"]
        or peer["reviewedInterpretationHash"] != canonical(scientific)
        or peer["role"] != "chemist-reviewer"
        or peer["authorCompletionId"] == peer["completionId"]
        or any(f["severity"] == "blocking" for f in peer["value"]["findings"])
    ):
        raise ValueError("Missing matching independent scientific/chemistry review")
    packet = read(root / "provider-packet.json")
    snap = read(root / "snapshot.json")
    names = read(root / "bindings.private.json")
    maps = read(root / "private-science-bindings.json")
    facts = read(root / "private-scientific-facts.json")
    defs = {m["materialAlias"]: m for m in snap["privateChemistryDefinitions"]}
    sections = [
        section(
            "priorities",
            "Priorities for this week",
            "本周研发重点",
            {
                l: "<ol>"
                + "".join(
                    "<li>" + escape(q[l]) + "</li>" for q in scientific["priorities"]
                )
                + "</ol>"
                for l in ["en", "zh"]
            },
        )
    ]
    decisions = read(root / "project-decisions.json")
    decisions_review = read(root / "project-decisions-review.json")
    if (
        digest(root / "project-decisions.json")
        != decisions_review["decisionBundleSha256"]
        or decisions["schemaVersion"] != 1
    ):
        raise ValueError("Project decisions differ from the independent review")
    source_files = [
        "rd-dossier.json",
        "provider-packet.json",
        "bindings.private.json",
        "snapshot.json",
    ]
    if set(decisions_review["files"]) != set(source_files) or any(
        decisions_review["files"][name] != digest(root / name) for name in source_files
    ):
        raise ValueError("Project decision source documents changed")
    ids = [p["id"] for p in packet["projects"]]
    if ids != [p["project"] for p in decisions["projects"]] or ids != [
        p["project"] for p in decisions_review["projects"]
    ]:
        raise ValueError("Project decision coverage differs")
    for receipt in decisions_review["projects"]:
        if (
            not receipt["authorCompletionId"]
            or not receipt["reviewerCompletionId"]
            or receipt["authorCompletionId"] == receipt["reviewerCompletionId"]
            or receipt["reviewDecision"] != "PASS"
        ):
            raise ValueError("Project decision lacks independent acceptance")
    decisions = display_project_text(decisions, names["projects"])
    save(root / "project-decisions-display.private.json", decisions)
    project_body = {}
    for lang in ("en", "zh"):
        zh = lang == "zh"
        rows = []
        for p, j in zip(packet["projects"], decisions["projects"], strict=True):
            name = names["projects"][p["id"]]["name"] or (
                "未分配" if zh else "Unassigned"
            )
            rows.append(
                [
                    name,
                    j["decision"][lang],
                    j["priorIssues"][lang],
                    j["next"][lang],
                    j["confidence"][lang],
                ]
            )
        project_body[lang] = table(
            ["项目", "当前判断", "上次问题的进展", "下一步验证", "判断依据与把握"]
            if zh
            else [
                "Project",
                "Current decision",
                "Previous question",
                "Next test",
                "Confidence and basis",
            ],
            rows,
        )
    sections.append(
        section("projects", "Project decisions", "各项目当前判断", project_body)
    )
    objectives = {
        lang: "".join(
            subsection(
                names["projects"][j["project"]]["name"]
                or ("Unassigned" if lang == "en" else "未分配"),
                j["purpose"][lang],
            )
            for j in decisions["projects"]
        )
        for lang in ("en", "zh")
    }
    articles = {p["paper"]: p for p in read(root / "article-refresh.json")}
    library = {k: "https://doi.org/" + p["doi"] for k, p in articles.items()}
    cases = []
    graph_aliases = set()
    sourceindex = []
    for i, case in enumerate(scientific["cases"]):
        key = case["experiment"]
        src = facts["cases"][i]
        src_case = next(c for c in packet["cases"] if c["id"] == key)
        case_binding = names["cases"][key]
        code = case_binding["code"]
        audit = [
            a
            for a in peer["value"]["scientificAudit"]
            if a["experiment"] == key
            and a["sourceHash"] == case["sourceHash"]
            and a["verdict"] == "PASS"
        ]
        if (
            len(audit) != 1
            or case_binding["sourceHash"] != case["sourceHash"]
            or src["experiment"] != key
        ):
            raise ValueError("Independent case/source audit unresolved")
        pub = case["public"]
        chem = case["chemical"]
        mapping = maps[key]
        graph = chem["status"] == "CURRENT_VERIFIED_GRAPH"
        if graph:
            alias = mapping["materials"][chem["material"]]
            mat = defs[alias]
            structural = mat["chemistry"]
            graph_aliases.add(alias)
            material_evidence = {
                "materialAlias": alias,
                "definitionStatus": "VALIDATED_CURRENT_GRAPH_NOT_HISTORICAL_LOT_PROOF",
                "inputHashStatus": "MATCH",
                "inputSha256": structural["inputSha256"],
                "definitionVersion": structural["version"],
                "localEngineVersion": structural["engineVersion"],
                "definitionGeneratedAt": structural["generatedAt"],
                "privateDescriptorFieldsConsulted": chem["consultedDescriptorFields"],
                "privateMotifMatchersConsulted": chem["consultedMotifFields"],
            }
        else:
            material_evidence = {"definitionStatus": "MISSING_FOR_CASE_IDENTITY"}
        material_evidence.update(
            historicalLotVerified=False,
            descriptorValuesAndGraphOmitted=True,
            sourceSnapshotAt=snap["snapshotAt"],
            caseIdentityBoundary=chem["identityBoundary"],
        )
        recipes = [
            {
                "recipeAlias": mapping["recipes"][r["id"]],
                "historicalActualCompositionVerified": False,
                "formulaIngredientsRatiosConcentrationsOmitted": True,
                "evidenceBasis": "Current linked recipe object.",
                "coarseAbsorberContext": r["coarseAbsorberContext"],
                "solventRoleContext": r["solventRole"],
                "ingredientLinkBasis": "Current recipe association; historical lot identity requires contemporaneous evidence.",
            }
            for r in chem["recipes"]
        ]
        record = {
            "experimentCode": code,
            "currentRecipeObjectPresent": bool(src["recipes"]),
            "actualCapturesPresent": src["actualCaptures"],
            "currentRecipeContexts": recipes,
            "actualRecipeOrSAMSolventHistoricalIdentityVerified": False,
            "SAMCarrierContext": chem["carrierContext"],
            "boundary": chem["identityBoundary"],
        }
        local = {
            "experimentCode": code,
            "sourceHash": case["sourceHash"],
            "groupLabels": [
                case_binding["groups"][x]
                for x in (case["reference"], case["comparator"])
                if x
            ],
            "conditionGroupLabels": [case_binding["groups"][row["group"]] for row in pub["conditions"]],
            "characterizationId": case_binding["characterizations"][
                case["characterization"]
            ],
            "policy": "accepted-device-result-v1",
            "asOf": packet["period"]["acceptedAsOf"],
        }
        annexcase = {
            "id": key.lower(),
            "materialName": chem["displayName"],
            "priority": spell_out_uv_test(chem["priority"]),
            "materialEvidence": material_evidence,
            "experimentEvidenceIds": [code],
            "fullStructureAndDescriptorVectorOmitted": True,
            "historicalIdentityAndMolecularCausalityConfirmed": False,
            "discriminatingControls": chem["controls"],
            "decisionCriteria": chem["criteria"],
            "competingExplanations": chem["alternatives"],
            "literatureSourceIds": chem["sources"],
            "recipeAndSolventEvidence": [record],
            "localDataBinding": local,
            "localOutcome": pub["result"]["en"],
            "reportSafeFutureSentence": pub["judgment"]["en"],
        }
        if graph:
            annexcase.update(
                status="CONDITIONAL_MOLECULE_SPECIFIC_HYPOTHESIS_CURRENT_GRAPH_ONLY",
                privateGraphToMechanismInterpretation=chem["graphHypotheses"],
                chemistryToRecipeCompatibility=chem["compatibility"],
            )
        else:
            annexcase.update(
                status="MOLECULE_SPECIFIC_REASONING_BLOCKED_PENDING_IDENTITY",
                candidateMappingStatus="NOT_CONFIRMED_DO_NOT_SUBSTITUTE",
                reason=chem["identityBoundary"],
                allowedCurrentReasoning=chem["limitations"],
                recordedCaseAliases=[mapping["materials"][chem["material"]]]
                if chem["material"]
                else [],
                candidateAlternateAliases=[],
            )
        cases.append(annexcase)
        body = {}
        test_body = {}
        for lang in ("en", "zh"):
            zh = lang == "zh"
            parts = [
                ("result", "Observed result", "实验结果"),
                ("judgment", "Current judgment", "当前判断"),
                ("keyIssue", "Main question", "当前问题"),
                ("nextStep", "Next test", "下一步验证"),
            ]
            text = "".join(
                subsection(hz if zh else he, pub[f][lang]) for f, he, hz in parts
            )
            text += (
                subsection(
                    "原实验目的" if zh else "Recorded purpose", pub["purpose"][lang]
                )
                + paragraph(pub["attainment"][lang])
                + paragraph(pub["comparison"][lang])
            )
            text += table(
                ["组别", "条件", "实际执行情况"]
                if zh
                else ["Group", "Condition", "Execution evidence"],
                [
                    [
                        case_binding["groups"][g["group"]],
                        g["condition"][lang],
                        g["execution"][lang],
                    ]
                    for g in pub["conditions"]
                ],
            )
            characterization = next(
                t
                for t in src_case["characterizations"]
                if t["id"] == case["characterization"]
            )
            metrics, extra_components = [], []
            condition_arms = {row["group"] for row in pub["conditions"]}
            for g in characterization["groups"]:
                if g["id"] not in condition_arms:
                    continue
                for metric, unit in [
                    ("pce", "PCE (%)"),
                    ("voc", "Voc (V)"),
                    ("jsc", "Jsc (mA/cm²)"),
                    ("ff", "FF (%)"),
                ]:
                    m = g["stats"].get(metric)
                    if m:
                        target = metrics if metric == "pce" or g["id"] in {case["reference"], case["comparator"]} else extra_components
                        target.append(
                            [
                                case_binding["groups"][g["id"]],
                                unit,
                                m["n"],
                                *[
                                    "—"
                                    if m.get(k) is None
                                    else f"{m[k]:.3f}".rstrip("0").rstrip(".") or "0"
                                    for k in ["mean", "best", "sd"]
                                ],
                            ]
                        )
            metric_headers = (
                ["组别", "指标", "器件数", "平均", "最高", "标准差"] if zh
                else ["Group", "Quantity", "Devices", "Mean", "Highest", "SD"]
            )
            text += table(metric_headers, metrics)
            body[lang] = text
            t = "".join(
                subsection(hz if zh else he, pub[f][lang])
                for f, he, hz in [
                    ("materialProposal", "Material/process proposal", "材料与工艺建议"),
                    ("reasoning", "Working hypothesis", "目前假设"),
                    ("alternative", "Competing explanation", "其他可能原因"),
                    ("discriminator", "Discriminating test", "区分两种解释的实验"),
                    ("criteria", "Proposed criteria", "建议判断标准"),
                ]
            )
            design = pub["designInterpretation"]
            t += subsection(
                "记录的前期观察" if zh else "Recorded observation",
                design["observation"][lang],
            )
            t += (
                subsection(
                    "原问题与假设" if zh else "Original question and hypothesis",
                    design["problem"][lang],
                )
                + paragraph(design["hypothesis"][lang])
                + paragraph(design["retrospectiveOrProspective"][lang])
            )
            signatures = pub["signatures"]
            t += paragraph(signatures["cochangedFactors"][lang]) + table(
                ["原因假设", "验证量", "单位", "预期变化"]
                if zh
                else ["Explanation", "Discriminator", "Unit", "Expected change"],
                [
                    [
                        label,
                        signatures[k]["quantity"][lang],
                        signatures[k]["unit"][lang],
                        signatures[k]["expectedChange"][lang],
                    ]
                    for k, label in [
                        ("preferredCause", "主要假设" if zh else "Working hypothesis"),
                        ("alternativeCause", "其他解释" if zh else "Alternative"),
                    ]
                ],
            )
            t += table(
                ["验证结果", "后续决策"] if zh else ["Outcome", "Follow-up decision"],
                [
                    [name, pub["branches"][k][lang]]
                    for k, name in [
                        ("positive", "符合预期" if zh else "Expected signature"),
                        (
                            "negative",
                            "预期未出现" if zh else "Expected signature absent",
                        ),
                        ("mixed", "结果不一致或测量无效" if zh else "Mixed or invalid"),
                    ]
                ],
            )
            t += (
                "<ul>"
                + "".join(
                    "<li>"
                    + escape(articles[k]["title"])
                    + " · DOI "
                    + escape(articles[k]["doi"])
                    + "</li>"
                    for k in chem["sources"]
                )
                + "</ul>"
            )
            if extra_components:
                t += "<h3>" + ("其他组别的器件参数" if zh else "Component measurements for the other groups") + "</h3>"
                t += table(metric_headers, extra_components)
            test_body[lang] = t
        sections.append(
            section("case-" + key.lower(), pub["name"]["en"], pub["name"]["zh"], body)
        )
        sections.append(
            section(
                "test-" + key.lower(),
                pub["name"]["en"] + " · validation",
                pub["name"]["zh"] + " · 验证方案",
                test_body,
            )
        )
        sourceindex.append(
            {
                "case": key,
                "sectionId": "case-" + key.lower(),
                "testSectionId": "test-" + key.lower(),
                "binding": local,
                "public": pub,
                "priority": chem["priority"],
            }
        )
    sections.append(
        section("project-purposes", "Project objectives", "各项目研发目标", objectives)
    )
    if scientific["followupAssessments"]:
        sections.append(
            section(
                "prior-action-review",
                "Previous hypotheses and actions",
                "前期假设与建议的进展",
                {
                    l: "<ul>"
                    + "".join(
                        "<li>" + escape(h["rationale"][l]) + "</li>"
                        for h in scientific["followupAssessments"]
                    )
                    + "</ul>"
                    for l in ("en", "zh")
                },
            )
        )
    sections.append(
        section(
            "methods",
            "How results were selected",
            "结果选取口径",
            {
                "en": paragraph(
                    "The app selected one accepted complete result per physical device and characterization. Mean PCE, highest PCE and device-to-device spread are separate quantities. The group results are cumulative at "
                    + packet["period"]["acceptedAsOf"]
                    + ". Weekly counts use measurement time. A dash indicates a missing statistic."
                ),
                "zh": paragraph(
                    "应用按实物器件及测试项目各选取一条已接受且指标完整的结果。平均效率、最高效率与器件间差异分别计算。组别统计累计至 "
                    + packet["period"]["acceptedAsOf"]
                    + "。每周扫描数按测量时间统计；缺失量用横线表示。"
                ),
            },
        )
    )
    end = packet["period"]["end"]
    document = {
        "titleEn": "Weekly R&D decisions · " + end[:10],
        "titleZh": "每周研发决策 · " + end[:10],
        "summaryEn": scientific["priorities"][0]["en"],
        "summaryZh": scientific["priorities"][0]["zh"],
        "snapshotAt": snap["snapshotAt"],
        "windowStart": packet["period"]["start"],
        "windowEnd": end,
        "sections": sections,
    }
    candidate_path = root / "report-document-candidate.json"
    if candidate_path.exists():
        prior = read(candidate_path)
        timestamp = prior.pop("generatedAt", None)
        if not timestamp or prior != document:
            raise ValueError("Assembled content differs from the saved report candidate")
        document["generatedAt"] = timestamp
    else:
        document["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        save(candidate_path, document)
    sources = [
        "snapshot.json",
        "private-chemistry-descriptors.json",
        "science-interpretation.json",
        "independent-material-science-review.json",
    ]
    private = {
        "schemaVersion": 1,
        "classification": "PRIVATE_MATERIAL_MECHANISM_REVIEW_NONRECONSTRUCTIVE",
        "preparedBy": "Private scientific author and independent reviewer using "
        + peer["model"],
        "reviewedAt": peer["reviewedAt"],
        "snapshotAt": snap["snapshotAt"],
        "scope": "Materials and treatments for the selected device comparisons. The independent scientific reviewer examined the bounded source context and both report languages.",
        "inputs": [{"file": name, "sha256": digest(root / name)} for name in sources],
        "sourceLibrary": library,
        "limitations": [
            "Current registered material identity is separate from historical lot evidence.",
            "A device metric alone does not identify a molecular mechanism.",
        ],
        "graphSupportedExactCaseMaterials": len(graph_aliases),
        "materialCases": cases,
        "publicationStatus": "PRIVATE_FUTURE_WORKFLOW_INPUT_ONLY_NOT_PUBLISHED",
    }
    save(root / "private-material-review.json", private)
    save(
        root / "science-public-index.private.json",
        {
            "cases": sourceindex,
            "publicDocumentAtAssembly": digest(root / "report-document-candidate.json"),
            "followupAssessments": [
                {**h, **maps[h["experiment"]]["ledger"][h["id"]]}
                for h in scientific["followupAssessments"]
            ],
            "privateReviewOutcomeHash": peer["outputHash"],
            "privateInterpretationHash": peer["reviewedInterpretationHash"],
        },
    )
    print(
        "Assembled reviewed case passages and bound molecular annex. Final manuscript gates remain separate."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    assemble_science(parser.parse_args().run.resolve())
