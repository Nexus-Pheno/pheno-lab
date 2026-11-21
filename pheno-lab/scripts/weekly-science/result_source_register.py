"""Public, method-specific provenance for every result used in weekly decisions."""

from project_names import names_from_source
from datetime import datetime
from hashlib import sha256
from html import escape, unescape
import hashlib
import json
import re

PERIODS = ("CURRENT_PERIOD", "PREVIOUS_EQUAL_DURATION_PERIOD", "EARLIER_HISTORY")
STRICT = "STRICT_RECORDED_PROTOCOL"
LIMITED = "TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL"
LABELS = {
    "en": {
        "CURRENT_PERIOD": "This week",
        "PREVIOUS_EQUAL_DURATION_PERIOD": "Previous week",
        "EARLIER_HISTORY": "Earlier history",
    },
    "zh": {
        "CURRENT_PERIOD": "本周",
        "PREVIOUS_EQUAL_DURATION_PERIOD": "上一周",
        "EARLIER_HISTORY": "更早时段",
    },
}
SHA = re.compile(r"[a-f0-9]{64}\Z")


def check(ok, message):
    if not ok:
        raise ValueError(message)


def signature(data):
    return sha256(
        json.dumps(
            data,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def unique(rows, key):
    found = {x[key]: x for x in rows}
    check(len(rows) == len(found), "Duplicate result source identity")
    return found


def anchor(lang, identity):
    return "result-source-" + lang + "-" + sha256(identity.encode()).hexdigest()[:16]


def link(identifier, text):
    return (
        '<a href="#'
        + escape(identifier, quote=True)
        + '">'
        + escape(str(text))
        + "</a>"
    )


def fingerprint(h):
    check(bool(SHA.fullmatch(h)), "Invalid scientific source digest")
    return (
        '<code data-source-sha256="'
        + h
        + '">'
        + "<wbr>".join(h[i : i + 8] for i in range(0, len(h), 8))
        + "</code>"
    )


def dt(v):
    parsed = datetime.fromisoformat(v.replace("Z", "+00:00"))
    check(parsed.utcoffset() is not None, "Undated route source")
    return parsed


def read(root, name):
    return json.loads((root / name).read_bytes())


def file_hash(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def cohort_population(c, window, scans, snapshot_hash):
    aliases = sorted(c["measurementAliases"])
    n = c["inferenceOutcomes"]["nScans"]
    check(
        n > 0 and len(aliases) == len(set(aliases)) == n,
        "Conflicting secondary cohort scan count",
    )
    included = []
    for alias in aliases:
        row = scans.get(alias)
        check(
            row
            and row.get("sourceLinked")
            and row.get("sampleAlias")
            and all(
                row[k] == c[k]
                for k in (
                    "experimentCode",
                    "group",
                    "direction",
                    "runAlias",
                    "instrumentAlias",
                )
            )
            and dt(window["start"]) <= dt(row["measuredAt"]) < dt(window["end"]),
            "Cohort is not bound to measured scans in its stated period",
        )
        included.append([alias, row["sampleAlias"], row["measuredAt"], row["metrics"]])
    check(
        len({r[1] for r in included}) == c["inferenceOutcomes"]["nSamples"],
        "Cohort device denominator differs from eligible source rows",
    )
    return signature(
        {
            "method": "physical-device-scan-medians-v1",
            "snapshotSha256": snapshot_hash,
            "cohortId": c["routeCohortId"],
            "view": c["view"],
            "start": window["start"],
            "end": window["end"],
            "measurements": included,
        }
    )


def statistics(c):
    o = c["inferenceOutcomes"]
    m = o["metrics"]["pce"]
    e = c["pceExtremes"]
    return dict(
        nScans=o["nScans"],
        nSamples=o["nSamples"],
        championScanPce=e["championValidScan"]["pce"],
        bestPhysicalSampleMedianPce=e["bestPhysicalSampleMedian"]["pce"],
        meanSampleMedianPce=m["mean"],
        medianSampleMedianPce=m["median"],
        sdSampleMedianPce=m["sampleStandardDeviation"],
        iqrSampleMedianPce=m["iqr"],
    )


def collect(snapshot, snapshot_hash, dossier, source, bindings, reviews):
    check(
        SHA.fullmatch(snapshot_hash)
        and source["files"]["snapshot.json"] == snapshot_hash
        and dt(dossier["snapshotAt"]) == dt(snapshot["snapshotAt"]),
        "Project results refer to another measured snapshot",
    )
    app = snapshot["sharedAppEvidence"]
    exported = unique(app["experiments"], "experimentCode")
    selected = unique(list(bindings["cases"].values()), "code")
    check(
        set(exported) == set(selected), "Accepted device export coverage is incomplete"
    )
    cases = {
        code: dict(
            code=code,
            scope=b["scope"],
            sha=exported[code]["evidence"]["sourceHash"],
            ref=exported[code]["evidence"]["reference"]["selectedGroup"],
            chars=[
                (ch["name"], ch["nSelectedDevices"])
                for ch in exported[code]["evidence"]["characterizations"]
            ],
            strict=False,
            limited=False,
        )
        for code, b in selected.items()
    }
    for code, b in selected.items():
        e = exported[code]["evidence"]
        check(
            b["sourceHash"] == cases[code]["sha"]
            and e["experiment"]["code"] == code
            and SHA.fullmatch(cases[code]["sha"])
            and cases[code]["scope"]
            in (
                "detailed-comparison",
                "covered-in-inventory",
                "no-accepted-characterization",
            ),
            "Accepted experiment source or inclusion status differs",
        )
    scans = unique(
        [
            r
            for r in snapshot["sampleMeasurements"]
            + snapshot["historicalSampleMeasurements"]
            if r.get("measurementAlias")
        ],
        "measurementAlias",
    )
    by_alias = {p["projectAlias"] or "UNASSIGNED": p for p in dossier["projects"]}
    by_review = unique(reviews, "projectAlias")
    out = []
    for src in source["projects"]:
        token = src["project"]
        alias = bindings["projects"][token]["projectAlias"] or "UNASSIGNED"
        d = by_alias[alias]["periodPerformance"]
        review = by_review[alias]
        panels = unique(d["routeCohorts"], "routeCohortId")
        project = dict(
            project=token,
            alias=alias,
            name=src["name"],
            windows=d["windows"],
            rows=[],
            coverage=[],
            pairs=[],
            representative={},
        )
        seen = set()

        def row(c, view, period):
            cid = c["routeCohortId"]
            check(
                cid not in seen
                and c["view"] == view
                and c["periodCohort"] == period
                and c["evidenceTier"] == "SOURCE_LINKED_INSTRUMENT_SCAN",
                "Incorrect method, window or duplicate secondary source",
            )
            seen.add(cid)
            h = cohort_population(c, d["windows"][period], scans, snapshot_hash)
            m = statistics(c)
            project["rows"].append(
                dict(
                    code=c["experimentCode"],
                    group=c["group"],
                    direction=c["direction"],
                    period=period,
                    id=cid,
                    route=c["routeId"],
                    method=view,
                    scans=m["nScans"],
                    devices=m["nSamples"],
                    sha=h,
                )
            )
            if c["experimentCode"] in cases:
                cases[c["experimentCode"]][
                    "strict" if view == STRICT else "limited"
                ] = True
            return m

        for case in src["routeCases"]:
            code = case["experimentCode"]
            project["representative"][case["representativeRouteId"]] = (
                case["sourcePeriod"],
                case["hashBasis"],
            )
            check(
                (
                    case["hashBasis"] == "app-accepted"
                    and code in cases
                    and case["sourceHash"] == cases[code]["sha"]
                )
                or (case["hashBasis"] == "dossier-intent-route" and code not in cases),
                "Wrong accepted-device attribution for a strict route",
            )
            for route in case["routes"]:
                for value in route["cohorts"]:
                    per = value["sourcePeriod"]
                    c = panels[route["routeId"] + ":" + per]
                    check(
                        c["experimentCode"] == code
                        and (c["group"] or "") == route["group"]
                        and (c["direction"] or "") == route["direction"],
                        "Strict route experiment, group or direction differs",
                    )
                    m = row(c, STRICT, per)
                    for a, b in [
                        ("nSamples", "nSamples"),
                        ("championScan", "championScanPce"),
                        ("bestSampleMedian", "bestPhysicalSampleMedianPce"),
                        ("mean", "meanSampleMedianPce"),
                        ("median", "medianSampleMedianPce"),
                        ("sd", "sdSampleMedianPce"),
                        ("iqr", "iqrSampleMedianPce"),
                    ]:
                        check(
                            value[a] == m[b],
                            "Strict project statistic differs from the frozen cohort",
                        )
        check(
            review["analysisView"] == LIMITED
            and [p["period"] for p in review["periods"]] == list(PERIODS),
            "Period table method or coverage differs",
        )
        for p in review["periods"]:
            tag = p["period"]
            eligible = sum(
                c["view"] == LIMITED
                and c["periodCohort"] == tag
                and c["evidenceTier"] == "SOURCE_LINKED_INSTRUMENT_SCAN"
                and c["inferenceOutcomes"]["nScans"] > 0
                for c in panels.values()
            )
            check(
                eligible == len(p["cohorts"]) + p["omittedCohortCount"]
                and (p["status"] == "NO_ELIGIBLE_DATA") == (eligible == 0),
                "Period table is missing eligible or empty windows",
            )
            project["coverage"].append([tag, eligible, len(p["cohorts"])])
            for item in p["cohorts"]:
                m = row(panels[item["cohortId"]], LIMITED, tag)
                check(
                    m == item["statistics"],
                    "Displayed period statistics differ from their source",
                )
        for pair in review["longitudinalJudgment"]["pairs"]:
            a, b = pair["currentCohortId"], pair["referenceCohortId"]
            check(
                a in seen
                and b in seen
                and panels[a]["view"] == panels[b]["view"] == LIMITED
                and panels[a]["routeId"] == panels[b]["routeId"]
                and panels[a]["periodCohort"] == PERIODS[0]
                and panels[b]["periodCohort"] != PERIODS[0],
                "Invalid matched period reference",
            )
            project["pairs"].append([a, b])
        out.append(project)
    check(
        len(out) == len(by_alias) == len(reviews)
        and {p["alias"] for p in out} == set(by_alias),
        "Incomplete source-register projects",
    )
    return dict(
        snapshot=snapshot_hash,
        at=snapshot["snapshotAt"],
        asOf=app["asOf"],
        policy=app["methodVersion"],
        cases=list(cases.values()),
        projects=out,
    )


def table(headers, rows):
    return (
        '<div class="table-wrap"><table><thead><tr>'
        + "".join("<th>" + escape(h) + "</th>" for h in headers)
        + "</tr></thead><tbody>"
        + "".join(
            "<tr>" + "".join("<td>" + v + "</td>" for v in row) + "</tr>"
            for row in rows
        )
        + "</tbody></table></div>"
    )


def render(register, lang):
    zh = lang == "zh"
    bi = lambda en, cn: cn if zh else en
    text = [
        f'<div id="{anchor(lang, "inventory")}"><h3>'
        + bi("Result sources by measurement method", "按计算口径核对结果来源")
        + "</h3>"
    ]
    text.append(
        "<p>"
        + bi(
            "The accepted-device analysis selects one accepted measurement vector for each physical device and characterization. The route analysis separately groups source-linked scans by measurement date and computes per-device scan medians. One method’s digest does not authenticate results computed by the other.",
            "器件结果按每片实物和每种表征选取一组已接受的测量值。路线统计另按实测日期分组，先计算每片器件的扫描中位数。核对时请使用对应方法的校验值。",
        )
        + "</p>"
    )
    text.append(
        "<p>"
        + bi("Frozen measured snapshot", "实测数据快照")
        + " · "
        + escape(register["at"])
        + " · "
        + fingerprint(register["snapshot"])
        + "</p><h4>"
        + bi("All experiments in the accepted-device export", "本次导出的全部器件实验")
        + "</h4><p>"
        + bi("Accepted results through", "已接受器件结果截至")
        + " "
        + escape(register["asOf"])
        + " · "
        + escape(register["policy"])
        + "</p>"
    )
    rows = []
    for c in register["cases"]:
        detail = c["scope"] == "detailed-comparison"
        if detail:
            relevance = bi("Detailed experiment review", "本期重点实验")
        elif c["scope"] == "no-accepted-characterization":
            relevance = bi(
                "No eligible characterization for detailed comparison",
                "无可供详细比较的已接受表征",
            )
        elif c["strict"] or c["limited"]:
            relevance = bi(
                "Included in the export; the route analyses below cover this experiment",
                "已导出；下列路线分析涉及该实验",
            )
        else:
            relevance = bi(
                "Inventory only; other eligible cases were selected for detailed follow-up",
                "本期仅列入清单；详细跟踪选择了其他符合条件的实验",
            )
        char = " / ".join(
            (
                (
                    bi("J–V solar simulation", "太阳光模拟 J–V")
                    if n == "J-V — solar simulation"
                    else bi("Characterization ", "表征 ") + str(i)
                )
                + " (n="
                + str(count)
                + ")"
            )
            for i, (n, count) in enumerate(c["chars"], 1)
        ) or bi("No characterization", "无表征")
        rows.append(
            [
                escape(c["code"]),
                relevance,
                char
                + " · "
                + bi("reference ", "参照组 ")
                + escape(str(c["ref"] or bi("unselected", "未选定"))),
                fingerprint(c["sha"]),
            ]
        )
    text.append(
        table(
            [
                bi("Experiment", "实验"),
                bi("Use this week", "本期用途"),
                bi("Characterization and accepted devices", "表征与已接受器件数"),
                bi("Accepted source SHA-256", "器件数据 SHA-256"),
            ],
            rows,
        )
    )
    for p in register["projects"]:
        text.append(
            f'<h4 id="{anchor(lang, p["project"])}">'
            + escape(p["nameEn"] if not zh else (p["name"] or "未分配项目实验"))
            + "</h4>"
        )
        text.append(
            "<p>"
            + bi(
                "Measured windows (start inclusive, end exclusive)",
                "实测时段（含开始、不含结束）",
            )
            + " · "
            + " / ".join(
                LABELS[lang][k]
                + " "
                + escape(p["windows"][k]["start"] + " – " + p["windows"][k]["end"])
                for k in PERIODS
            )
            + "</p>"
        )
        rows = p["rows"]
        strict = [r for r in rows if r["method"] == STRICT]
        panel = [r for r in rows if r["method"] == LIMITED]
        for lis, title in (
            (
                strict,
                bi(
                    "Project decisions · exact recorded protocol",
                    "项目判断 · 严格匹配记录的扫描条件",
                ),
            ),
            (
                panel,
                bi(
                    "Period tables · limited protocol match",
                    "时段统计表 · 匹配已记录的部分条件",
                ),
            ),
        ):
            text.append("<h5>" + title + "</h5>")
            if not lis:
                text.append(
                    "<p>"
                    + bi(
                        "No selected measured cohort for this view.",
                        "此口径未选入实测组。",
                    )
                    + "</p>"
                )
                continue
            groups = {}
            for r in lis:
                groups.setdefault(r["route"], []).append(r)
            trows = []
            for group in groups.values():
                first = group[0]
                values = {r["period"]: r for r in group}
                bits = []
                for per in PERIODS:
                    r = values.get(per)
                    if not r:
                        continue
                    bits.append(
                        f'<div id="{anchor(lang, r["id"])}">'
                        + LABELS[lang][per]
                        + " · "
                        + bi("scans / devices ", "扫描数 / 器件数 ")
                        + f"{r['scans']} / {r['devices']}<br>"
                        + fingerprint(r["sha"])
                        + "</div>"
                    )
                rep = p["representative"].get(first["route"])
                if rep:
                    bits.append(
                        "<small>"
                        + bi(
                            "Lead measured cohort in the project decision: ",
                            "项目判断选用的主要实测组：",
                        )
                        + LABELS[lang][rep[0]]
                        + " · "
                        + (
                            bi(
                                "accepted-device source also in the inventory above",
                                "上表同时列有器件结果来源",
                            )
                            if rep[1] == "app-accepted"
                            else bi(
                                "no accepted-device export for this historical case",
                                "本次器件导出未含该历史实验",
                            )
                        )
                        + "</small>"
                    )
                missing = [LABELS[lang][k] for k in PERIODS if k not in values]
                if missing:
                    bits.append(
                        "<small>"
                        + bi("Absent from this source selection: ", "本口径未选入：")
                        + escape(", ".join(missing))
                        + "</small>"
                    )
                direction = {
                    "REVERSE": bi("reverse", "反扫"),
                    "FORWARD": bi("forward", "正扫"),
                }.get(
                    first["direction"], str(first["direction"] or bi("unknown", "未知"))
                )
                trows.append(
                    [
                        escape(str(first["code"])),
                        escape(str(first["group"] or "—")) + " · " + escape(direction),
                        "".join(bits),
                    ]
                )
            text.append(
                table(
                    [
                        bi("Experiment", "实验"),
                        bi("Group / scan direction", "组别 / 扫描方向"),
                        bi(
                            "Measured period and cohort SHA-256",
                            "实测时段与扫描组 SHA-256",
                        ),
                    ],
                    trows,
                )
            )
        text.append(
            "<p>"
            + bi(
                "Period table selection (shown / eligible): ", "时段表选入 / 符合条件："
            )
            + " / ".join(
                LABELS[lang][t] + " " + str(shown) + " / " + str(eligible)
                for t, eligible, shown in p["coverage"]
            )
            + ".</p>"
        )
        if not p["pairs"]:
            text.append(
                "<p>"
                + bi(
                    "The period table selected no same-route reference pair. A missing comparison is left open.",
                    "时段表未选入同一路线的跨期对照，缺少可比数据时不计算变化。",
                )
                + "</p>"
            )
        for a, b in p["pairs"]:
            text.append(
                "<p>"
                + bi("Matched comparison: ", "同路线的跨期对比：")
                + link(anchor(lang, a), bi("current cohort", "本周实测组"))
                + " / "
                + link(anchor(lang, b), bi("reference cohort", "参照时段实测组"))
                + "</p>"
            )
    text.append("</div>")
    return "".join(text)


def register_for(root, snapshot, dossier, doc):
    bindings = read(root, "bindings.private.json")
    register = collect(
        snapshot,
        file_hash(root / "snapshot.json"),
        dossier,
        read(root, "project-source-packet.private.json"),
        bindings,
        doc["decisionReview"]["projectReviews"],
    )
    labels = {
        p["project"]: p["english"]
        for p in names_from_source(
            snapshot, bindings["projects"], read(root, "project-decisions.json")
        )
    }
    for p in register["projects"]:
        p["nameEn"] = labels[p["project"]]
    return register


def attach(root, snapshot, dossier, doc):
    register = register_for(root, snapshot, dossier, doc)
    sections = {s["id"]: s for s in doc["sections"]}
    for lang in ("en", "zh"):
        key = "body" + lang.title()
        sections["sources"][key] += render(register, lang)
        project = sections["projects"][key]
        project_rows = iter(register["projects"])

        def reference(m):
            p = next(project_rows)
            display = unescape(re.search(r"<td>([^<>]*)</td>", m[1])[1])
            allowed = {p["nameEn"]} if lang == "en" else {p["name"] or "未分配项目实验"}
            if not p["name"] or p["alias"] == "UNASSIGNED":
                allowed.update(
                    {"Unassigned", "Unassigned experiments"}
                    if lang == "en"
                    else {"未分配", "未分配项目的实验", "未分配项目实验"}
                )
            check(
                display in allowed, "Source register link points at a different project"
            )
            return (
                m[1]
                + m[2]
                + " "
                + link(
                    anchor(lang, p["project"]),
                    "Result sources" if lang == "en" else "结果来源",
                )
                + "</td>"
            )

        body, n = re.subn(
            r'((?:<tbody>|</tr>)<tr(?: id="prior-project-(?:en|zh)-[0-9]+")?><td>[^<>]*</td><td>)(.*?)</td>',
            reference,
            project,
            flags=re.S,
        )
        check(
            n == len(register["projects"]),
            "Project source links do not match the decision table",
        )
        sections["projects"][key] = body
    return register


def verify(root, snapshot, dossier, doc):
    register = register_for(root, snapshot, dossier, doc)
    sections = {s["id"]: s for s in doc["sections"]}
    for lang in ("en", "zh"):
        key = "body" + lang.title()
        check(
            render(register, lang) in sections["sources"][key],
            "Visible result source register differs from frozen inputs",
        )
        for p in register["projects"]:
            check(
                'href="#' + anchor(lang, p["project"]) + '"'
                in sections["projects"][key],
                "Project decision has no source link",
            )
            for row in p["rows"]:
                if row["method"] == LIMITED:
                    check(
                        sections["routes"][key].count(
                            'href="#' + anchor(lang, row["id"]) + '"'
                        )
                        == 3,
                        "Displayed route values do not link to their exact measured cohort",
                    )
    return register
