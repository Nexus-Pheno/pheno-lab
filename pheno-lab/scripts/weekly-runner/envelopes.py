"""Bind the reviewed case interpretations to the frozen evidence; final approvals are supplied separately."""

from collections import defaultdict
from html import escape
import hashlib
import math
import json
from pathlib import Path
import re
import sys

SCI = Path(__file__).resolve().parents[1] / "weekly-science"
sys.path.insert(0, str(SCI))
import validate_rd_document as public
import validate_decision_report as decision
import validate_academic_report as academic
import validate_collaborator_report as collaborator

LANGS = ("en", "zh")
AUTHOR = "Weekly research author"
SELECTION = dict(
    en="Each physical device contributes one accepted result for each characterization. The device comparisons use the cumulative results at export.",
    zh="相同测试项目下，每片实物器件只计一条已接受的结果。器件比较采用导出时的累计数据。",
)
TEMPORAL = dict(
    en="The design fields describe what the team recorded. Their timestamps do not establish a prospective decision threshold.",
    zh="设计栏说明团队记录的研究想法。现有时间记录不足以确定事前判断阈值。",
)
NO_ENTRY = dict(en="The team left this field blank.", zh="团队未填写此栏。")


def bi(k, v):
    return {k + l.title(): v[l] for l in LANGS}


def read(p):
    return json.loads(p.read_bytes())


def save(p, v):
    with p.open("x") as f:
        json.dump(v, f, ensure_ascii=False, separators=(",", ":"))


def append(section, value):
    for l in LANGS:
        key = "body" + l.title()
        content = escape(value[l])
        if content not in section[key]:
            section[key] += "<p>" + content + "</p>"


def section(tag, en, zh):
    return dict(id=tag, titleEn=en, titleZh=zh, bodyEn="", bodyZh="")


def stamp(raw):
    return hashlib.sha256((raw or "").encode()).hexdigest()


def fmt(v):
    return "—" if v is None else f"{v:.4f}".rstrip("0").rstrip(".")


def table(head, rows):
    return (
        '<div class="table-wrap"><table><thead><tr>'
        + "".join("<th>" + escape(str(v)) + "</th>" for v in head)
        + "</tr></thead><tbody>"
        + "".join(
            "<tr>" + "".join("<td>" + escape(str(v)) + "</td>" for v in r) + "</tr>"
            for r in rows
        )
        + "</tbody></table></div>"
    )


def route_panels(project, part, project_decision, experiments):
    view = "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL"
    cohorts = [
        c
        for c in project["periodPerformance"]["routeCohorts"]
        if c["view"] == view
        and c["evidenceTier"] == "SOURCE_LINKED_INSTRUMENT_SCAN"
        and c["inferenceOutcomes"]["nScans"]
    ]
    # One paired route chosen by time and coverage, before examining its performance.
    usable = {
        c["routeCohortId"]: c
        for c in cohorts
        if all(
            c["pceExtremes"].get(k)
            for k in ("championValidScan", "bestPhysicalSampleMedian")
        )
    }
    candidates = []
    for c in usable.values():
        if c["periodCohort"] != "CURRENT_PERIOD":
            continue
        for order, period in enumerate(
            ("PREVIOUS_EQUAL_DURATION_PERIOD", "EARLIER_HISTORY")
        ):
            ref = usable.get(c["routeId"] + ":" + period)
            if ref:
                coverage = min(
                    c["inferenceOutcomes"]["nSamples"],
                    ref["inferenceOutcomes"]["nSamples"],
                )
                candidates.append(
                    (order, -coverage, c["routeCohortId"], ref["routeCohortId"])
                )
    matched = min(candidates)[2:] if candidates else ()
    selected_stats = {}
    periods = []
    for tag in ("CURRENT_PERIOD", "PREVIOUS_EQUAL_DURATION_PERIOD", "EARLIER_HISTORY"):
        population = [c for c in cohorts if c["periodCohort"] == tag]
        eligible = [
            c
            for c in population
            if c.get("direction") == "REVERSE"
            and all(
                c["pceExtremes"].get(k)
                for k in ("championValidScan", "bestPhysicalSampleMedian")
            )
        ]
        chosen = {}
        for field in ("championValidScan", "bestPhysicalSampleMedian"):
            if eligible:
                winner = max(eligible, key=lambda c: c["pceExtremes"][field]["pce"])
                chosen[winner["routeCohortId"]] = winner
        for key in matched:
            if usable[key]["periodCohort"] == tag:
                chosen[key] = usable[key]
        data = []
        rows = []
        for key, c in chosen.items():
            outcomes = c["inferenceOutcomes"]
            m = outcomes["metrics"]["pce"]
            stats = dict(
                nScans=outcomes["nScans"],
                nSamples=outcomes["nSamples"],
                championScanPce=c["pceExtremes"]["championValidScan"]["pce"],
                bestPhysicalSampleMedianPce=c["pceExtremes"][
                    "bestPhysicalSampleMedian"
                ]["pce"],
                meanSampleMedianPce=m["mean"],
                medianSampleMedianPce=m["median"],
                sdSampleMedianPce=m["sampleStandardDeviation"],
                iqrSampleMedianPce=m["iqr"],
            )
            limit = dict(
                en="Interpret this route within its recorded scan protocol. Confirm the illuminated area, conditioning and independent fabrication batches before transferring a gain.",
                zh="按该路线记录的扫描条件解读结果。推广增益前，先核对光照面积、预处理和独立制备批次。",
            )
            selected_stats[key] = stats
            data.append(
                dict(
                    cohortId=key,
                    statistics=stats,
                    comparabilityStatus="DESCRIPTIVE_ONLY",
                    batchReplicationStatus="UNVERIFIED_INDEPENDENT_BATCHES",
                    **bi("comparabilityLimits", limit),
                )
            )
            rows.append(
                [
                    c["experimentCode"],
                    c["group"],
                    c["direction"],
                    *map(fmt, stats.values()),
                    *[
                        f"{fmt(outcomes['metrics'][k]['mean'])} ({outcomes['metrics'][k]['nSamples']})"
                        if outcomes["metrics"].get(k)
                        else "—"
                        for k in ("voc", "jsc", "ff")
                    ],
                ]
            )
            append(part, limit)
        reason = dict(
            en=f"{tag.replace('_', ' ').lower()}: {len(population)} routes. The table shows the highest reverse scan and best device median where available.",
            zh=f"本时段共 {len(population)} 条路线。表中列出适用时反扫最高值及最佳器件中位数对应的路线。",
        )
        if matched and any(k in chosen for k in matched):
            reason["en"] += (
                " The table also includes the route selected for the cross-period comparison."
            )
            reason["zh"] += " 表中也列出用于跨时段比较的路线。"
        append(part, reason)
        for l, header in [
            (
                "en",
                [
                    "Experiment",
                    "Group",
                    "Scan direction",
                    "Scans",
                    "Devices",
                    "Highest scan %",
                    "Best device median %",
                    "Mean %",
                    "Median %",
                    "SD pp",
                    "IQR pp",
                    "Voc V (n)",
                    "Jsc mA/cm² (n)",
                    "FF % (n)",
                ],
            ),
            (
                "zh",
                [
                    "实验",
                    "组别",
                    "扫描方向",
                    "扫描数",
                    "器件数",
                    "最高扫描 %",
                    "最佳器件中位 %",
                    "平均 %",
                    "中位 %",
                    "标准差 百分点",
                    "四分位距 百分点",
                    "Voc V（片）",
                    "Jsc mA/cm²（片）",
                    "FF %（片）",
                ],
            ),
        ]:
            if rows:
                part["body" + l.title()] += table(header, rows)
        periods.append(
            dict(
                period=tag,
                status="NO_ELIGIBLE_DATA"
                if not population
                else "SOURCE_BOUND"
                if len(population) == 1
                else "MIXED_COHORT_NO_SINGLE_MEAN",
                cohorts=data,
                omittedCohortCount=len(population) - len(data),
                **bi("selectionReason", reason),
            )
        )
    limit = dict(
        en="The period leaders can differ in route and preparation. These panels alone cannot quantify a matched before-and-after change.",
        zh="各时段领先器件的路线和制备条件可能不同。仅凭这些面板无法量化匹配条件下的前后变化。",
    )
    pairs = []
    if matched:
        current_key, previous_key = matched
        current, previous = selected_stats[current_key], selected_stats[previous_key]
        changes = {
            k: current[k] - previous[k]
            if current[k] is not None and previous[k] is not None
            else None
            for k in decision.STAT_DEFINITIONS
        }
        label = (
            usable[current_key]["experimentCode"]
            + " / "
            + str(usable[current_key]["group"])
        )
        period_en, period_zh = (
            ("previous week", "上周期")
            if usable[previous_key]["periodCohort"] == "PREVIOUS_EQUAL_DURATION_PERIOD"
            else ("earlier history", "历史时段")
        )
        interpretation = dict(
            en=f"{label}: mean device-median PCE was {fmt(current['meanSampleMedianPce'])}% this week and {fmt(previous['meanSampleMedianPce'])}% in the {period_en}. Device counts were {current['nSamples']} and {previous['nSamples']}.",
            zh=f"{label}：本周各器件扫描中位效率的平均值为 {fmt(current['meanSampleMedianPce'])}%，{period_zh}为 {fmt(previous['meanSampleMedianPce'])}%。两期分别有 {current['nSamples']} 片和 {previous['nSamples']} 片器件。",
        )
        limit = dict(
            en="The two windows match on recorded conditions and scan direction. Unrecorded scan settings and fabrication batches limit the interpretation of this difference.",
            zh="两时段已记录的条件和扫描方向一致。仍需核对未记录的扫描设置和制备批次，才能判断差异的来源。",
        )
        append(part, interpretation)
        pairs.append(
            dict(
                currentCohortId=current_key,
                referenceCohortId=previous_key,
                differencesCurrentMinusReference=changes,
                **bi("interpretation", interpretation),
            )
        )
    append(part, limit)
    alias = project["projectAlias"] or "UNASSIGNED"
    reason = project_decision["reason"]
    append(part, reason)
    return dict(
        projectAlias=alias,
        sectionId=part["id"],
        analysisView=view,
        periods=periods,
        longitudinalJudgment=dict(
            status="EXPLORATORY_CHANGE" if pairs else "INSUFFICIENT_COMPARABLE_DATA",
            pairs=pairs,
            **bi("analysis", project_decision.get("longitudinal", reason)),
            **bi("limits", limit),
        ),
        routeDecisions=[
            dict(
                id="route-" + str(project_decision["alias"]).lower(),
                sectionId=part["id"],
                experimentCodes=experiments,
                decision=project_decision["decision"] if cohorts else "HOLD",
                confidence=project_decision["confidence"],
                evidenceIds=experiments,
                **bi("reason", reason),
            )
        ],
    )


def comparisons(e, ch_id):
    out = []
    for ch in e["characterizations"]:
        if ch["id"] != ch_id:
            continue
        for group in ch["groups"]:
            m = group["metrics"].get("pce") or {}
            out.append(
                dict(
                    characterizationId=ch_id,
                    group=group["label"],
                    nDevices=m.get("n", 0),
                    meanPce=m.get("mean"),
                    bestPce=m.get("best"),
                    sdPce=m.get("sd"),
                    deltaMeanPce=group.get("deltaMean", {}).get("pce"),
                    deltaBestPce=group.get("deltaBest", {}).get("pce"),
                    potential=group["judgment"],
                    evidenceConfidence=group["evidenceConfidence"],
                )
            )
    return out


def pce_figure(characterization, selected_groups, language):
    """Draw the two accepted-device summaries and label the number behind each series."""
    arms = [
        g
        for g in characterization["groups"]
        if g["label"] in selected_groups and g["metrics"].get("pce")
    ]
    if not arms:
        return ""
    zh = language == "zh"
    heading = (
        "对照与实验组的器件效率" if zh else "Device efficiency in the selected arms"
    )
    note = (
        "圆点为平均值；菱形为最高值。器件间离散性见条件表。"
        if zh
        else "Circles show mean PCE and diamonds show the highest device. The table gives device-to-device spread."
    )
    width = 540
    height = 65 + 58 * len(arms)
    left, right = 82, 453
    maximum = max(5, 5 * math.ceil(max(g["metrics"]["pce"]["best"] for g in arms) / 5))
    points = lambda value: left + (right - left) * value / maximum
    svg = [
        f'<figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="{heading}"><title>{heading}</title>',
        f'<rect width="{width}" height="{height}" fill="white"/>',
    ]
    for i in range(6):
        val = maximum * i / 5
        x = points(val)
        svg.append(
            f'<line x1="{x}" x2="{x}" y1="32" y2="{height - 28}" stroke="#d6dedb"/><text x="{x}" y="22" text-anchor="middle" font-size="14" fill="#263c33">{fmt(val)}%</text>'
        )
    for i, g in enumerate(arms):
        m = g["metrics"]["pce"]
        y = 58 + i * 58
        label = escape(str(g["label"]))
        a, b = points(m["mean"]), points(m["best"])
        svg.extend(
            [
                f'<text x="4" y="{y + 4}" fill="#223e34" font-size="15">{label}</text>',
                f'<line x1="{a}" x2="{b}" y1="{y}" y2="{y}" stroke="#65896a" stroke-width="2"/>',
                f'<circle cx="{a}" cy="{y}" r="6" fill="#265c4b"/>',
                f'<path d="M{b},{y - 7} l7,7 l-7,7 l-7,-7 Z" fill="white" stroke="#714824" stroke-width="2"/>',
                f'<text x="470" y="{y + 4}" fill="#263c33" font-size="14">n={m["n"]}</text>',
            ]
        )
    return (
        "".join(svg)
        + "</svg><figcaption>"
        + heading
        + ". "
        + note
        + "</figcaption></figure>"
    )


def case_records(c, s, e, chem, refs, articles, sections, priority):
    p = c["public"]
    key = c["case"].lower()
    code = c["binding"]["experimentCode"]
    case = sections[c["sectionId"]]
    test = sections[c["testSectionId"]]
    condition = p["comparison"]
    question = p["keyIssue"]
    expid = c["sectionId"]
    tid = c["testSectionId"]
    for a in (p["result"], p["judgment"], p["keyIssue"], p["nextStep"], condition):
        append(case, a)
    lng = dict(
        experimentCode=code,
        sectionId=expid,
        resultEvidenceStatus="OBSERVED",
        nextStepStatus="PROPOSED_NOT_EXECUTED",
        keyIssueStatus="SPECIFIC",
        **bi("result", p["result"]),
        **bi("judgment", p["judgment"]),
        **bi("keyIssue", question),
        **bi("nextStep", p["nextStep"]),
    )
    primary = dict(
        experimentCode=code,
        sectionId=expid,
        selectionSectionId="methods",
        sourceHash=e["sourceHash"],
        policyVersion=e["policyVersion"],
        referenceGroup=e["reference"]["selectedGroup"],
        aiInterpretationUsed=False,
        comparisons=comparisons(e, c["binding"]["characterizationId"]),
        **bi("conditionSummary", condition),
        **bi("selectionDefinition", SELECTION),
        **bi("judgment", p["judgment"]),
        **bi("mainIssue", question),
        **bi("nextTest", p["nextStep"]),
    )
    ctx = sections["context"]
    inp = {}
    design = p["designInterpretation"]
    for field in ("observation", "problem", "hypothesis"):
        raw = s.get(field) or ""
        present = bool(public.html_plain(raw)[0].strip())
        interpretation = design.get(field, p["purpose"]) if present else NO_ENTRY
        inp[field] = dict(
            sourceField=field,
            status="SOURCE_RECORDED" if present else "NOT_RECORDED",
            textSha256=stamp(raw) if present else None,
            **bi("reviewerInterpretation", interpretation),
        )
        append(ctx, interpretation)
    goal = any(inp[f]["status"] == "SOURCE_RECORDED" for f in ("problem", "hypothesis"))
    att = dict(
        status={
            "answered": "ANSWERED",
            "partially-answered": "PARTIAL",
            "unresolved": "UNRESOLVED",
            "insufficient-recorded-purpose": "NO_PRESPECIFIED_GOAL",
        }[p["attainmentStatus"]]
        if goal
        else "NO_PRESPECIFIED_GOAL",
        goalBasis="REVIEWER_INTERPRETATION_OF_CURRENT_FIELDS"
        if goal
        else "NO_DOCUMENTED_GOAL",
        evidenceIds=refs,
        **bi("analysis", p["attainment"]),
    )
    selected = dict(
        experimentCode=code,
        sectionId="context",
        temporalBasis="CURRENT_AT_SNAPSHOT",
        recordedInputs=inp,
        objectiveAttainment=att,
        **bi("copiedOrRetrospectiveLimits", TEMPORAL),
    )
    context = dict(
        experimentCode=code,
        sectionId="context",
        contextStatus="PARTIAL" if goal else "MISSING_PURPOSE",
        temporalBasis="CURRENT_NOT_PREREGISTERED",
        sourceFieldHashes={k: stamp(s.get(k)) for k in collaborator.SOURCE_FIELDS},
        **bi("knownPurpose", p["purpose"]),
        **bi("decisionCriticalGap", question),
        **bi("interpretationBoundary", TEMPORAL),
        **bi("questionForLab", p["discriminator"]),
    )
    for x in (p["attainment"], p["purpose"], question, TEMPORAL, p["discriminator"]):
        append(ctx, x)
    source = s.get("projectAlias") or "UNASSIGNED"
    primary_cause = p["reasoning"]
    alternative = p["alternative"]
    control = p["nextStep"]
    criterion = p["criteria"]
    neg = p["branches"]["negative"]
    pos = p["branches"]["positive"]
    mixed = p["branches"]["mixed"]
    cause = dict(
        id="cause-" + key,
        sectionId=tid,
        experimentCodes=[code],
        rankingStatus="UNRESOLVED_COMPETING_CAUSES",
        confidence="LOW",
        **bi("rankingReason", p["judgment"]),
    )
    for slot, cause_id, statement in [
        ("primaryCause", "primary-", primary_cause),
        ("runnerUpCause", "rival-", alternative),
    ]:
        cause[slot] = dict(
            id=cause_id + key,
            supportingEvidenceIds=refs,
            opposingEvidenceIds=[],
            **bi("statement", statement),
            **bi("oppositionLimits", question),
        )
    sign = p["signatures"]
    expected = sign["preferredCause"]["expectedChange"]
    rival = sign["alternativeCause"]["expectedChange"]
    measurement = p["discriminator"]
    unit = " / ".join(
        dict.fromkeys(
            [
                sign["preferredCause"]["unit"]["en"],
                sign["alternativeCause"]["unit"]["en"],
            ]
        )
    )
    if isinstance(unit, dict):
        unit = unit["en"]
    branches = {
        k: dict(**bi("condition", value), **bi("nextDecision", value))
        for k, value in [("positive", pos), ("negative", neg), ("mixedInvalid", mixed)]
    }
    action = dict(
        id="validation-" + key,
        causeReviewId=cause["id"],
        sectionId=tid,
        priority=priority,
        status="PROPOSED",
        executed=False,
        criterionStatus="PROPOSED_NOT_PREREGISTERED",
        evidenceIds=refs,
        **bi("controls", control),
        **bi("measurement", measurement),
        **bi("expectedSignature", expected),
        **bi("proposedCriterion", criterion),
        **bi("thresholdBasis", p.get("thresholdBasis", criterion)),
        branches=branches,
        discriminatingSignatures=[
            dict(
                measurement=measurement["en"],
                unit=unit,
                **bi("primaryExpected", expected),
                **bi("runnerUpExpected", rival),
            )
        ],
    )
    mat = dict(
        id="proposal-" + key,
        sectionId=tid,
        candidateBasis="CURRENT_VERIFIED_REGISTRY"
        if chem["status"] == "CURRENT_VERIFIED_GRAPH"
        else "NAME_IDENTITY_PENDING",
        priority=priority,
        sourceExperimentCodes=[code],
        status="PROPOSED_NOT_EXECUTED",
        executed=False,
        evidenceIds=refs,
        **bi("observation", p["result"]),
        **bi("proposal", p["materialProposal"]),
        **bi("mechanism", primary_cause),
        **bi("cochangedProperties", p["signatures"]["cochangedFactors"]),
        **bi("challenge", alternative),
        **bi("experiment", control),
        **bi("decision", pos),
        **bi("rankingReason", p["judgment"]),
    )
    for item in (
        p["result"],
        p["materialProposal"],
        primary_cause,
        alternative,
        question,
        control,
        criterion,
        pos,
        neg,
        mixed,
        measurement,
        expected,
        rival,
        p["judgment"],
        p["signatures"]["cochangedFactors"],
        p.get("thresholdBasis", criterion),
    ):
        append(test, item)
    primary_action = dict(
        id="next-" + key,
        sectionId=tid,
        projectAlias=source,
        priority=priority,
        confidence="LOW",
        status="PROPOSED",
        executed=False,
        hypothesis=primary_cause["en"],
        controlledTest=control["en"],
        decisionCriterion=criterion["en"],
        evidenceIds=refs,
    )
    urls = [
        a
        for a in articles
        if a["paper"] in chem["sources"] or a["doi"] in chem["sources"]
    ]
    if not urls:
        raise ValueError("Selected case has no reviewed primary publication.")
    lit = [
        dict(url="https://doi.org/" + a["doi"], claim=primary_cause["en"]) for a in urls
    ]
    mech = dict(
        id="mechanism-" + key,
        sectionId=tid,
        projectAlias=source,
        reasoning=primary_cause["en"],
        discriminatingTest=p["discriminator"]["en"],
        alternatives=[alternative["en"]],
        localEvidence=refs,
        literatureEvidence=lit,
    )
    char = next(
        ch
        for ch in e["characterizations"]
        if ch["id"] == c["binding"]["characterizationId"]
    )
    for lang in LANGS:
        case["body" + lang.title()] += pce_figure(
            char, c["binding"]["groupLabels"], lang
        )
    metrics = []
    for name, unit in academic.METRIC_UNITS.items():
        cells = [
            f"{g['label']} {fmt(g['metrics'][name]['mean'])} (n={g['metrics'][name]['n']})"
            for g in char["groups"]
            if g["metrics"].get(name)
        ]
        obs = (
            dict(
                en="Group means: " + ", ".join(cells) + ".",
                zh="各组均值：" + "，".join(cells) + "。",
            )
            if cells
            else dict(
                en="No accepted value for this quantity.", zh="此项没有已接受的结果。"
            )
        )
        metrics.append(
            dict(
                name=name,
                unit=unit,
                status=(
                    "UNVERIFIED_NORMALIZATION" if name in ("voc", "jsc") else "OBSERVED"
                )
                if cells
                else "MISSING",
                evidenceIds=refs if cells else [],
                **bi("observation", obs),
            )
        )
    core = dict(
        id="core-" + key,
        sectionId=expid,
        theoryModelIds=["loaded-power"],
        evidenceIds=refs,
        metrics=metrics,
        primaryMechanism=dict(id="primary-" + key, **bi("statement", primary_cause)),
        competingCauses=[dict(id="rival-" + key, **bi("statement", alternative))],
        predictions=[
            dict(
                mechanismId=which + key,
                measurement=measurement["en"],
                **bi("signature", sig),
            )
            for which, sig in [("primary-", expected), ("rival-", rival)]
        ],
        evidenceStatus="TESTABLE_HYPOTHESIS",
        **bi("discriminatingExperiment", control),
        **bi("decisionCriterion", criterion),
    )
    return dict(
        language=lng,
        primary=primary,
        context=context,
        selected=selected,
        cause=cause,
        action=action,
        card=mat,
        next=primary_action,
        mechanism=mech,
        core=core,
    )


def historical_context(code, decision_row, source, assessment, ctx):
    fields = {}
    for field in ("observation", "problem", "hypothesis"):
        raw = source.get(field) or ""
        present = bool(public.html_plain(raw)[0].strip())
        value = decision_row[field] if present else NO_ENTRY
        fields[field] = dict(
            sourceField=field,
            status="SOURCE_RECORDED" if present else "NOT_RECORDED",
            textSha256=stamp(raw) if present else None,
            **bi("reviewerInterpretation", value),
        )
        append(ctx, value)
    goal = any(
        fields[f]["status"] == "SOURCE_RECORDED" for f in ("problem", "hypothesis")
    )
    objective = dict(
        status=assessment["status"],
        goalBasis=assessment["goalBasis"],
        evidenceIds=assessment["evidenceIds"],
        **bi("analysis", assessment["reason"]),
    )
    design = dict(
        experimentCode=code,
        sectionId=ctx["id"],
        temporalBasis="CURRENT_AT_SNAPSHOT",
        recordedInputs=fields,
        objectiveAttainment=objective,
        **bi("copiedOrRetrospectiveLimits", TEMPORAL),
    )
    context = dict(
        experimentCode=code,
        sectionId=ctx["id"],
        contextStatus="PARTIAL" if goal else "MISSING_PURPOSE",
        temporalBasis="CURRENT_NOT_PREREGISTERED",
        sourceFieldHashes={k: stamp(source.get(k)) for k in collaborator.SOURCE_FIELDS},
        **bi("knownPurpose", decision_row["purpose"]),
        **bi("decisionCriticalGap", decision_row["comparison"]),
        **bi("interpretationBoundary", TEMPORAL),
        **bi("questionForLab", decision_row["next"]),
    )
    for v in (
        assessment["reason"],
        decision_row["purpose"],
        decision_row["comparison"],
        TEMPORAL,
        decision_row["next"],
    ):
        append(ctx, v)
    return design, context


def assemble(work, prior):
    doc = read(work / "report-document-candidate.json")
    snapshot = read(work / "snapshot.json")
    ds = read(work / "rd-dossier-reviewed.json")
    baseline = read(prior / "run-result.json")
    q = read(work / "science-public-index.private.json")["cases"]
    if not q:
        raise ValueError(
            "No measured case available; prior prediction follow-up is required."
        )
    science = read(work / "science-interpretation.json")
    articles = read(work / "article-refresh.json")
    proj = read(work / "project-decisions.json")
    sections = {s["id"]: s for s in doc["sections"]}
    for key, en, zh in [
        ("routes", "Route results across three periods", "三个时段的路线结果"),
        ("context", "Research questions and earlier decisions", "实验目的与前期问题"),
        ("sources", "Sources and evidence coverage", "文献与数据范围"),
    ]:
        sections[key] = section(key, en, zh)
    sections["methods"]["bodyEn"] = (
        "<p>"
        + SELECTION["en"]
        + "</p><p>Results are frozen at "
        + escape(snapshot["sharedAppEvidence"]["asOf"])
        + ". Weekly changes are counted by measurement time. A dash means the statistic is unavailable.</p>"
    )
    sections["methods"]["bodyZh"] = (
        "<p>"
        + SELECTION["zh"]
        + "</p><p>器件结果截取于 "
        + escape(snapshot["sharedAppEvidence"]["asOf"])
        + "。周内变化按测量时间统计，横线表示该统计量缺失。</p>"
    )
    obs = {e["code"]: e for e in snapshot["experimentSummaries"]}
    ex = {
        r["experimentCode"]: r["evidence"]
        for r in snapshot["sharedAppEvidence"]["experiments"]
    }
    scans = {
        r["measurementAlias"]: r
        for r in snapshot["sampleMeasurements"]
        + snapshot["historicalSampleMeasurements"]
        if r.get("measurementAlias")
    }
    rows = defaultdict(list)
    current = {}
    for i, c in enumerate(q):
        code = c["binding"]["experimentCode"]
        source = obs[code]
        char = next(
            v
            for v in ex[code]["characterizations"]
            if v["id"] == c["binding"]["characterizationId"]
        )
        groups = set(c["binding"]["groupLabels"])
        linked = {}
        for result in char["selectedResults"]:
            measurement = result.get("sourceMeasurementId")
            if measurement:
                alias = stamp("pheno-report-alias-v1:" + measurement)[:24]
                scan = scans.get(alias)
                if (
                    scan
                    and scan.get("experimentCode") == code
                    and scan.get("group") in groups
                ):
                    linked.setdefault(scan["group"], alias)
        refs = [code, *linked.values()]
        chem = next(
            x["chemical"] for x in science["cases"] if x["experiment"] == c["case"]
        )
        for k, v in case_records(
            c,
            source,
            ex[code],
            chem,
            refs,
            articles,
            sections,
            ("P0", "P1", "P2")[min(i, 2)],
        ).items():
            rows[k].append(v)
        current[code] = c
    for a in articles:
        url = "https://doi.org/" + a["doi"]
        line = (
            '<p><a href="'
            + escape(url, quote=True)
            + '">'
            + escape(a["title"])
            + "</a></p>"
        )
        for lang in LANGS:
            sections["sources"]["body" + lang.title()] += line
    routes = []
    issues = []
    previous = read(prior / "rd-dossier-published.json")
    ledger = {e["entryId"]: e for e in previous["ledgerEntries"]}
    project_candidates = proj["projects"]
    attainment = {
        (r["project"], r["experimentCode"], r["sourceHash"]): r
        for r in read(work / "project-attainment.json")["rows"]
    }
    bmap = read(work / "bindings.private.json")["projects"]
    project_receipts = {
        r["project"]: r
        for r in read(work / "project-decisions-review.json")["projects"]
    }
    verified_changes = {r["entryId"]: r for r in ds["ledgerEntries"]}
    for p in ds["projects"]:
        alias = p["projectAlias"] or "UNASSIGNED"
        row = next(
            r
            for r in project_candidates
            if (bmap[r["project"]]["projectAlias"] or "UNASSIGNED") == alias
        )
        codes = [
            c for c in current if (obs[c].get("projectAlias") or "UNASSIGNED") == alias
        ]
        for intent in row["routeIntents"]:
            code = intent["experimentCode"]
            if (obs[code].get("projectAlias") or "UNASSIGNED") != alias:
                raise ValueError("Historical comparison belongs to another project.")
            if code not in codes:
                codes.append(code)
            if code not in {b["experimentCode"] for b in rows["selected"]}:
                detail, context = historical_context(
                    code,
                    intent,
                    obs[code],
                    attainment[(row["project"], code, intent["sourceHash"])],
                    sections["context"],
                )
                rows["selected"].append(detail)
                rows["context"].append(context)
        decision_row = dict(
            alias="p" + str(len(routes) + 1),
            decision=row["routeDisposition"],
            confidence=row["confidenceLevel"],
            reason=row["decision"],
        )
        routes.append(route_panels(p, sections["routes"], decision_row, codes))
        lookup = {
            v["key"]: v["entryId"]
            for v in project_receipts[row["project"]]["issueBindings"]
        }
        # All prior entries receive an independent assessment. Detail changed issues
        # and one remaining open question per project in the report appendix.
        chosen = [
            v
            for v in row["issueAssessments"]
            if v["assessment"] != "no-new-direct-test"
            or ledger[lookup[v["key"]]] != verified_changes[lookup[v["key"]]]
        ]
        for v in row["issueAssessments"]:
            if v["assessment"] == "no-new-direct-test" and v not in chosen:
                chosen.append(v)
                break
        for follow in chosen:
            ident = lookup[follow["key"]]
            old = ledger[ident]
            new = verified_changes[ident]
            changed = old != new
            item = dict(
                entryId=ident,
                sectionId="context",
                currentStatus=new["status"],
                revision=new["revision"],
                assessment="REVIEWED_UPDATE"
                if changed
                else "UNCHANGED_NO_NEW_EVIDENCE",
                executionStatus="NOT_VERIFIED",
                evidenceIds=[
                    k
                    for k in new["history"][-1]["evidenceIdentifiers"]
                    if k in obs or k in scans
                ]
                if changed
                else [],
                **bi("analysis", follow["rationale"]),
            )
            issues.append(item)
            append(sections["context"], follow["rationale"])
    issue_scope = dict(
        selectedEntryIds=[r["entryId"] for r in issues],
        omittedUnchangedCount=len(ledger) - len(issues),
        **bi(
            "selectionReason",
            dict(
                en="The project review follows earlier questions that could affect this week’s decisions. Other previous entries remain in the dated ledger.",
                zh="项目复核跟踪会影响本周判断的前期问题。其余历史条目保留在有日期的记录中。",
            ),
        ),
    )
    new_count = sum(p["newSourceAliasesSincePriorSnapshots"] for p in ds["projects"])
    roles = dict(
        projects="projects",
        performance=q[0]["sectionId"],
        reproducibility="routes",
        continuity="context",
        mechanisms=q[0]["testSectionId"],
        priorities="priorities",
        limitations="context",
        literature="sources",
    )
    _, _, missing = public.material_coverage(snapshot)
    doc["rdReview"] = dict(
        schemaVersion=1,
        preparedBy=AUTHOR,
        projectAliases=[p["projectAlias"] or "UNASSIGNED" for p in ds["projects"]],
        sectionIds=roles,
        reviewMarks={},
        priorityActions=rows["next"],
        mechanismCards=rows["mechanism"],
        chemistryLimitations=[
            dict(materialAlias=a, reason=r, sectionId="context")
            for a, r in sorted(missing.items())
        ],
        continuitySourceReportIds=[baseline["reportId"]],
    )
    doc["decisionReview"] = dict(
        schemaVersion=1,
        preparedBy=AUTHOR,
        pceUnit="%",
        statisticsDefinitions=decision.STAT_DEFINITIONS,
        expectationPolicy="LLM_PROPOSALS_IN_REPORT_NOT_RECORDED_EXPERIMENT_FIELDS",
        enforceVisibleDecisions=True,
        projectReviews=routes,
        selectedExperiments=rows["selected"],
        causeReviews=rows["cause"],
        validationActions=rows["action"],
        priorIssueScope=issue_scope,
        priorIssueReviews=issues,
        peerReview={},
    )
    main = [
        "projects",
        "priorities",
        "methods",
        *[c["sectionId"] for c in q],
        *[c["testSectionId"] for c in q],
    ]
    first = q[0]
    sid = first["sectionId"]
    first_case = first["public"]
    theory = dict(
        id="loaded-power",
        sectionId=sid,
        evidenceStatus="EXPLANATORY_NOT_FITTED",
        **bi(
            "name",
            dict(en="Efficiency at a fixed irradiance", zh="固定辐照度下的转换效率"),
        ),
        **bi(
            "relation",
            dict(
                en="PCE = Voc × Jsc × FF / incident irradiance, using fractional FF and consistent area units.",
                zh="效率等于开路电压、短路电流密度与填充因子的乘积除以入射辐照度。填充因子按小数计，面积单位须一致。",
            ),
        ),
        **bi("explanation", first_case["reasoning"]),
        **bi("localApplicability", first_case["keyIssue"]),
        assumptionsEn=[
            "Compare the same illumination, area convention and device or module definition."
        ],
        assumptionsZh=["比较时保持光照、面积定义和器件或组件口径一致。"],
        variables=[
            dict(
                symbol=a,
                meaningEn=b,
                meaningZh=c,
                unit=u,
                status="DERIVED" if a == "PCE" else "MEASURED",
            )
            for a, b, c, u in [
                ("Voc", "Open-circuit voltage", "开路电压", "V"),
                ("Jsc", "Short-circuit current density", "短路电流密度", "mA/cm²"),
                ("FF", "Fill factor", "填充因子", "1"),
                ("PCE", "Power conversion efficiency", "转换效率", "1"),
                ("Pin", "Incident irradiance", "入射辐照度", "mW/cm²"),
            ]
        ],
        publicSourceUrls=["https://doi.org/" + a["doi"] for a in articles],
    )
    append(sections[sid], dict(en=theory["relationEn"], zh=theory["relationZh"]))
    appendix = (
        (["project-purposes"] if "project-purposes" in sections else [])
        + ["routes", "context", "sources"]
        + (["prior-action-review"] if "prior-action-review" in sections else [])
    )
    doc["academicReview"] = dict(
        schemaVersion=1,
        preparedBy=AUTHOR,
        reportStyle=academic.DECISION_STYLE,
        scientificMainSectionIds=main,
        appendixSectionIds=appendix,
        sectionIds=dict(
            abstract="projects",
            questions=sid,
            theory=sid,
            methods="methods",
            resultsDiscussion=sid,
            conclusions="priorities",
            appendixContinuity="context",
            appendixProjectProgress="routes",
            appendixEvidenceHistory="routes",
            appendixInventory="sources",
        ),
        researchQuestions=[
            dict(
                id="question-" + c["case"].lower(),
                sectionId=c["sectionId"],
                **bi("question", c["public"]["keyIssue"]),
            )
            for c in q
        ],
        coreCases=rows["core"],
        theoryModels=[theory],
        authorAttestation={k: True for k in academic.DECISION_AUTHOR_MARKS},
        peerReview={},
    )
    doc["collaboratorReview"] = dict(
        schemaVersion=1,
        preparedBy=AUTHOR,
        rankingBasis=collaborator.RANKING_BASIS,
        statisticalModelUsed=False,
        evidenceChange=dict(
            previousSnapshotAt=baseline["snapshotAt"],
            newMeasurementAliasCount=new_count,
            classification="NEW_MEASUREMENTS_PRESENT"
            if new_count
            else "NO_NEW_MEASUREMENTS_CONTEXT_REVISION",
        ),
        contextReviews=rows["context"],
        materialCards=rows["card"],
        peerReview={},
    )
    doc["languageReview"] = dict(
        schemaVersion=1,
        standardVersion="RESULT_JUDGMENT_ISSUE_NEXT_V1",
        preparedBy=AUTHOR,
        sharedMethodsSectionId="methods",
        commonStatements=[
            dict(id="accepted-device-selection", **bi("text", SELECTION))
        ],
        experiments=rows["language"],
        peerReview={},
    )
    doc["evidenceMethodReview"] = dict(
        schemaVersion=1,
        methodVersion=snapshot["sharedAppEvidence"]["methodVersion"],
        selectionScope="EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT",
        primaryEvidenceAsOf=snapshot["sharedAppEvidence"]["asOf"],
        legacyPeriodPanelsRole="SECONDARY_SCAN_MEDIAN_ROBUSTNESS_AND_PERIOD_TRACE",
        conditionDisclosurePolicy="NAMED_MATERIAL_DOSE_CARRIER_PROCESS_ONLY",
        privacyProjectionReviewed=False,
        experiments=rows["primary"],
        omittedExperimentCount=len(ex) - len(rows["primary"]),
    )
    doc["windowStart"] = snapshot["windowStart"]
    doc["windowEnd"] = snapshot["windowEnd"]
    doc["sections"] = [sections[k] for k in main + appendix]
    return doc
