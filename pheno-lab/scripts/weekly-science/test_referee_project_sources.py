import unittest

from referee_project_sources import project_sources


class RefereeProjectSourcesTests(unittest.TestCase):
    def test_private_packet_uses_original_rows_and_blinded_goal_for_each_project(self):
        windows = {p: {"start": "t0", "end": "t1"} for p in ("CURRENT_PERIOD", "EARLIER_HISTORY")}
        stats = {"nSamples": 2, "mean": 8.1, "median": 8.1, "sampleStandardDeviation": 1.0, "iqr": .5}
        route = dict(routeId="r", routeCohortId="r:current", experimentCode="E", group="A", direction="FORWARD",
                     view="trace", evidenceTier="SOURCE_LINKED_INSTRUMENT_SCAN", periodCohort="CURRENT_PERIOD",
                     inferenceOutcomes={"nScans": 8, "nSamples": 2, "metrics": {"pce": stats, "voc": {"nSamples": 1, "mean": .91}}},
                     pceExtremes={"championValidScan": {"pce": 10}, "bestPhysicalSampleMedian": {"pce": 9}})
        def source(key, route_cases, issues):
            return dict(project=key, name=key, assigned=key == "P1", measuredScans=8, earlierReceipts=0,
                        firstSeenSources=3, scope={}, routeCases=route_cases, priorIssues=issues)
        src_case = dict(experimentCode="E", sourceHash="hash", hashBasis="app-accepted", name="SAM", observation="observed",
                        problem="", hypothesis="", conclusion="", routes=[], currentAccepted=[])
        project_packet = {"projects": [
            source("P1", [src_case], [dict(key="L1", statement="repeat E", status="proposed", previousDecision="pending")]),
            source("P2", [], []),
        ]}
        projects, panels = [], []
        for alias, cases, rows in [("A", [{"experimentCode": "E"}], [route]), (None, [], [])]:
            projects.append({"projectAlias": alias, "experiments": cases, "periodPerformance": {"routeCohorts": rows, "windows": windows}})
            panels.append({"projectAlias": alias or "UNASSIGNED", "analysisView": "trace", "periods": [
                {"period": tag, "cohorts": [{"cohortId": "r:current", "statistics": {"nScans": 999}}]
                 if rows and tag == "CURRENT_PERIOD" else []} for tag in windows]})
        doc = {"decisionReview": {"projectReviews": panels, "priorIssueReviews": [{"entryId": "entry"}]},
               "evidenceMethodReview": {"experiments": [{"experimentCode": "E"}]}}
        dossier = {"projects": projects, "ledgerEntries": [{"entryId": "entry", "status": "inconclusive"}]}
        goals = {"rows": [dict(project="P1", experimentCode="E", sourceHash="hash", status="PARTIAL", goalBasis="inferred",
                               reason={"en": "Synthetic reason", "zh": "示例"}, evidenceIds=["private-scan"])]}
        receipts = {"projects": [dict(project="P1", issueBindings=[{"key": "L1", "entryId": "entry"}]), dict(project="P2", issueBindings=[])]}
        decision = {"projects": [dict(project="P1", issueAssessments=[dict(key="L1", assessment="partial-test",
                                testedExperimentCodes=["E"], rationale={"en": "New evidence"})]), dict(project="P2", issueAssessments=[])]}
        packet = project_sources(doc, dossier, project_packet, goals, receipts, decision,
                                 {"P1": {"projectAlias": "A"}, "P2": {"projectAlias": None}},
                                 {"E": {"inWindow": 8, "firstSeenInWindow": 3}})
        self.assertEqual(len(packet), 2)
        case = packet[0]["strictRouteCases"][0]
        self.assertEqual(case["weeklyScans"], {"inWindow": 8, "firstSeenInWindow": 3})
        self.assertEqual(case["blindedPurpose"]["goalBasis"], "inferred")
        self.assertNotIn("private-scan", str(packet))
        before, after = packet[0]["priorQuestions"][0], packet[0]["displayedRouteSources"]["periods"][0]["shownRoutes"][0]
        self.assertEqual((before["priorStatus"], before["currentStatus"]), ("proposed", "inconclusive"))
        self.assertEqual((after["scans"], after["devices"], after["highestDeviceMedian"]), (8, 2, 9))
        self.assertEqual(after["components"], {"voc": {"mean": .91, "nSamples": 1}})
        self.assertEqual([w["eligibleRoutes"] for w in packet[1]["displayedRouteSources"]["periods"]], [0, 0])
