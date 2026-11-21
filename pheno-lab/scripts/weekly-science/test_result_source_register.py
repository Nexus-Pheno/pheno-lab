from unittest import TestCase
from result_source_register import (
    collect,
    statistics,
    render,
    anchor,
    PERIODS,
    STRICT,
    LIMITED,
)


class ResultSources(TestCase):
    def setUp(self):
        self.snapsha = "1" * 64
        self.appsha = "2" * 64
        self.periods = {
            p: dict(
                start=f"2026-01-0{i + 1}T00:00:00Z", end=f"2026-01-0{i + 2}T00:00:00Z"
            )
            for i, p in enumerate(PERIODS)
        }
        e = dict(
            experiment=dict(code="A"),
            sourceHash=self.appsha,
            reference=dict(selectedGroup="B"),
            characterizations=[dict(name="J-V — solar simulation", nSelectedDevices=1)],
        )
        common = dict(
            experimentCode="A",
            group="B",
            direction="REVERSE",
            runAlias="private-run",
            instrumentAlias="private-instrument",
        )
        scan = dict(
            **common,
            measurementAlias="secret-scan",
            sampleAlias="secret-sample",
            sourceLinked=True,
            measuredAt="2026-01-01T12:00:00Z",
            metrics={"pce": 21.2},
        )
        self.snapshot = dict(
            snapshotAt="2026-10-01T13:14:15.001Z",
            sharedAppEvidence=dict(
                experiments=[dict(experimentCode="A", evidence=e)],
                asOf="later",
                methodVersion="accepted-v1",
            ),
            sampleMeasurements=[scan],
            historicalSampleMeasurements=[],
        )
        self.bind = dict(
            cases={
                "E1": dict(
                    code="A", scope="covered-in-inventory", sourceHash=self.appsha
                )
            },
            projects={"P1": dict(projectAlias="p")},
        )
        m = dict(
            nSamples=1, mean=21.2, median=21.2, sampleStandardDeviation=None, iqr=0
        )
        common.update(
            periodCohort=PERIODS[0],
            evidenceTier="SOURCE_LINKED_INSTRUMENT_SCAN",
            measurementAliases=["secret-scan"],
            inferenceOutcomes=dict(nScans=1, nSamples=1, metrics={"pce": m}),
            pceExtremes=dict(
                championValidScan={"pce": 21.2}, bestPhysicalSampleMedian={"pce": 21.2}
            ),
        )
        self.co = [
            dict(**common, routeId=k, routeCohortId=k + ":" + PERIODS[0], view=v)
            for k, v in [("strict", STRICT), ("shown", LIMITED)]
        ]
        self.ds = dict(
            snapshotAt="2026-10-01T13:14:15.001000+00:00",
            projects=[
                dict(
                    projectAlias="p",
                    periodPerformance=dict(windows=self.periods, routeCohorts=self.co),
                )
            ],
        )
        self.src = dict(
            files={"snapshot.json": self.snapsha},
            projects=[
                dict(
                    project="P1",
                    name="Display",
                    routeCases=[
                        dict(
                            experimentCode="A",
                            sourceHash=self.appsha,
                            hashBasis="app-accepted",
                            sourcePeriod=PERIODS[0],
                            representativeRouteId="strict",
                            routes=[
                                dict(
                                    routeId="strict",
                                    group="B",
                                    direction="REVERSE",
                                    cohorts=[
                                        dict(
                                            sourcePeriod=PERIODS[0],
                                            nSamples=1,
                                            championScan=21.2,
                                            bestSampleMedian=21.2,
                                            mean=21.2,
                                            median=21.2,
                                            sd=None,
                                            iqr=0,
                                        )
                                    ],
                                )
                            ],
                        )
                    ],
                )
            ],
        )
        self.review = [
            dict(
                projectAlias="p",
                analysisView=LIMITED,
                periods=[
                    dict(
                        period=k,
                        status="NO_ELIGIBLE_DATA" if i else "SOURCE_BOUND",
                        omittedCohortCount=0,
                        cohorts=[]
                        if i
                        else [
                            dict(
                                cohortId=self.co[1]["routeCohortId"],
                                statistics=statistics(self.co[1]),
                            )
                        ],
                    )
                    for i, k in enumerate(PERIODS)
                ],
                longitudinalJudgment=dict(pairs=[]),
            )
        ]

    def result(self):
        r = collect(
            self.snapshot, self.snapsha, self.ds, self.src, self.bind, self.review
        )
        r["projects"][0]["nameEn"] = "Display"
        return r

    def test_source_register_separates_three_populations_and_missing_windows(self):
        register = self.result()
        rows = register["projects"][0]["rows"]
        self.assertEqual(2, len(rows))
        self.assertEqual(len({r["sha"] for r in rows} | {self.appsha}), 3)
        self.assertTrue(
            register["cases"][0]["strict"] and register["cases"][0]["limited"]
        )
        for lang in ("en", "zh"):
            html = render(register, lang)
            for r in rows:
                self.assertIn(anchor(lang, r["id"]), html)
            self.assertNotIn("secret-scan", html)
            self.assertNotIn("secret-sample", html)
            self.assertIn(self.appsha, html)
            self.assertIn(
                "missing comparison" if lang == "en" else "缺少可比数据", html
            )

    def test_missing_direction_stays_unknown_across_dossier_and_author_packet(self):
        self.snapshot["sampleMeasurements"][0]["direction"] = None
        for row in self.co:
            row["direction"] = None
        self.src["projects"][0]["routeCases"][0]["routes"][0]["direction"] = ""
        result = self.result()
        self.assertIn("unknown", render(result, "en"))
        self.assertIn("未知", render(result, "zh"))

    def test_changed_frozen_source_fails(self):
        self.src["files"]["snapshot.json"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "another measured snapshot"):
            self.result()

    def test_crossed_source_date_and_device_count_fail(self):
        row = self.snapshot["sampleMeasurements"][0]
        row["measuredAt"] = "2026-01-02T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "measured scans"):
            self.result()
        row["measuredAt"] = "2026-01-01T12:00:00Z"
        self.co[0]["inferenceOutcomes"]["nSamples"] = 2
        with self.assertRaisesRegex(ValueError, "denominator"):
            self.result()

    def test_strict_statistic_cannot_be_substituted_with_accepted_device_result(self):
        self.src["projects"][0]["routeCases"][0]["routes"][0]["cohorts"][0]["mean"] = (
            21.1
        )
        with self.assertRaisesRegex(ValueError, "Strict project statistic"):
            self.result()

    def test_missing_export_or_unmeasured_reference_fails(self):
        self.bind["cases"]["E2"] = dict(
            code="other", scope="covered-in-inventory", sourceHash=self.appsha
        )
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.result()
        del self.bind["cases"]["E2"]
        self.review[0]["longitudinalJudgment"]["pairs"] = [
            dict(
                currentCohortId=self.co[1]["routeCohortId"], referenceCohortId="phantom"
            )
        ]
        with self.assertRaisesRegex(ValueError, "matched period reference"):
            self.result()

    def test_period_summary_must_agree_with_actual_eligible_counts(self):
        self.review[0]["periods"][2]["omittedCohortCount"] = 1
        with self.assertRaisesRegex(ValueError, "empty windows"):
            self.result()
