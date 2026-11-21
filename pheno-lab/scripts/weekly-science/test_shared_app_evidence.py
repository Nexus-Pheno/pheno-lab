#!/usr/bin/env python3
"""Synthetic app/weekly source binding, method migration and stale-AI contracts."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
from unittest import mock
import unittest

BASE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


shared = load('shared_app_evidence')
gate = load('validate_primary_evidence')
public_fixture = load('test_rd_document')
analysis_fixture = load('test_rd_analysis')
collector = load('collect_snapshot')


def attach(snapshot, code=None):
    code = code or snapshot['experimentSummaries'][0]['code']
    group = {'label': 'B', 'metrics': {'pce': {'n': 2, 'mean': 22, 'best': 23, 'sd': 1.4142135623730951}},
             'deltaMean': {'pce': 2}, 'deltaBest': {'pce': 3},
             'judgment': 'PROMISING_VARIABLE', 'evidenceConfidence': 'EXPLORATORY'}
    snapshot['sharedAppEvidence'] = {'schemaVersion': 1, 'readOnly': True,
        'methodVersion': shared.METHOD_VERSION, 'selectionScope': shared.SELECTION_SCOPE,
        'sourceSnapshotAt': snapshot['snapshotAt'], 'reportWindowEnd': snapshot['windowEnd'],
        'asOf': snapshot['snapshotAt'], 'experiments': [{'experimentCode': code,
            'evidence': {'schemaVersion': 1, 'policyVersion': shared.POLICY_VERSION, 'sourceHash': 'a' * 64,
                'screeningReferencePcePoints': 0.5, 'criterionStatus': 'EXPLORATORY_INTERNAL_REFERENCE_NOT_CONFIRMATION',
                'experiment': {'code': code, 'title': 'Synthetic comparison'},
                'reference': {'selectedGroup': 'A'},
                'conditions': [], 'characterizations': [{'id': 'synthetic-characterization', 'groups': [group]}]},
            'aiInterpretation': {'available': False, 'sourceHashMatches': False,
                                 'versionCurrent': False, 'expectedVersions': {
                                     'policyVersion': shared.POLICY_VERSION,
                                     'ruleVersion': 'purpose-screening-0.5pp-v1',
                                     'promptVersion': 'concise-bilingual-results-v1'},
                                 'selectionMatchesPrimaryEvidence': False, 'summary': None, 'reviewState': 'draft'}}]}
    return snapshot


def fixture():
    document, snapshot, dossier = public_fixture.fixture()
    attach(snapshot)
    dossier['primaryExperimentEvidence'] = shared.dossier_primary_evidence(snapshot)
    code = snapshot['experimentSummaries'][0]['code']
    binding = {'experimentCode': code, 'sourceHash': 'a' * 64, 'policyVersion': shared.POLICY_VERSION,
               'sectionId': 'projects', 'referenceGroup': 'A', 'aiInterpretationUsed': False,
               'comparisons': [{'characterizationId': 'synthetic-characterization', 'group': 'B',
                   'nDevices': 2, 'meanPce': 22, 'bestPce': 23, 'sdPce': 1.4142135623730951,
                   'deltaMeanPce': 2, 'deltaBestPce': 3,
                   'potential': 'PROMISING_VARIABLE', 'evidenceConfidence': 'EXPLORATORY'}]}
    for field in ('conditionSummary', 'selectionDefinition', 'judgment', 'mainIssue', 'nextTest'):
        binding[field + 'En'] = 'Synthetic ' + field + ': retain the promising condition and test preparation repeatability.'
        binding[field + 'Zh'] = '合成' + field + '：保留有潜力的条件，验证制备重复性。'
    document['evidenceMethodReview'] = {'schemaVersion': 1, 'methodVersion': shared.METHOD_VERSION,
        'selectionScope': shared.SELECTION_SCOPE, 'primaryEvidenceAsOf': snapshot['snapshotAt'],
        'legacyPeriodPanelsRole': 'SECONDARY_SCAN_MEDIAN_ROBUSTNESS_AND_PERIOD_TRACE',
        'conditionDisclosurePolicy': 'NAMED_MATERIAL_DOSE_CARRIER_PROCESS_ONLY',
        'privacyProjectionReviewed': True, 'experiments': [binding], 'omittedExperimentCount': 0}
    section = next(s for s in document['sections'] if s['id'] == 'projects')
    for lang in ('En', 'Zh'):
        section['body' + lang] += ''.join('<p>' + binding[field + lang] + '</p>'
            for field in ('conditionSummary', 'selectionDefinition', 'judgment', 'mainIssue', 'nextTest'))
    return document, snapshot, dossier


class SharedAppEvidenceTests(unittest.TestCase):
    def test_legacy_snapshot_and_scan_median_values_remain_unchanged(self):
        snapshot = analysis_fixture.snapshot([analysis_fixture.scan('one', pce=10),
                                               analysis_fixture.scan('two', pce=20)])
        legacy = analysis_fixture.rd.analyze(snapshot)
        self.assertIsNone(legacy['primaryExperimentEvidence'])
        attach(snapshot)
        upgraded = analysis_fixture.rd.analyze(snapshot)
        self.assertEqual(upgraded['projects'], legacy['projects'])
        self.assertEqual(upgraded['ledgerEntries'], legacy['ledgerEntries'])
        self.assertEqual(upgraded['primaryExperimentEvidence']['experiments'], snapshot['sharedAppEvidence']['experiments'])
        self.assertEqual(upgraded['primaryExperimentEvidence']['comparisonRule']['championPceGainPercentagePoints'], .5)
        self.assertTrue(upgraded['primaryExperimentEvidence']['comparisonRule']['lowerChampionGainIsNotAutomaticRejection'])

    def test_current_case_selection_excludes_receipt_only_old_outcomes(self):
        snapshot = {'sampleMeasurements': [{'experimentCode': 'E-current', 'measuredInPeriod': True},
                    {'experimentCode': 'E-receipt', 'receivedInPeriod': True, 'measuredInPeriod': False}],
                    'experimentSummaries': [{'code': 'E-plan', 'updatedInPeriod': True}]}
        self.assertEqual(shared.selected_experiment_codes(snapshot), ['E-current', 'E-plan'])

    def test_export_wrong_policy_cutoff_scope_or_coverage_fails(self):
        _, snapshot, _ = fixture()
        original = snapshot['sharedAppEvidence']
        for field, value in [('selectionScope', 'SEVEN_DAY_FABRICATIONS'),
                             ('sourceSnapshotAt', '2026-01-30T00:00:00Z'),
                             ('reportWindowEnd', '2026-01-30T00:00:00Z'), ('readOnly', False)]:
            candidate = copy.deepcopy(original)
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                shared.validate_export(candidate, snapshot)
        with self.assertRaises(ValueError):
            shared.validate_export(original, snapshot, ['different-code'])

    def test_stale_summary_is_history_not_a_current_source_match(self):
        _, snapshot, _ = fixture()
        export = snapshot['sharedAppEvidence']
        ai = export['experiments'][0]['aiInterpretation']
        ai.update(available=True, summary={'sourceHash': 'b' * 64}, sourceHashMatches=False)
        self.assertIs(shared.validate_export(export, snapshot), export)
        ai['sourceHashMatches'] = True
        with self.assertRaises(ValueError):
            shared.validate_export(export, snapshot)

    def test_collector_uses_existing_readonly_operator_and_exact_code_scope(self):
        _, snapshot, _ = fixture()
        code = snapshot['experimentSummaries'][0]['code']
        response = subprocess.CompletedProcess([], 0, stdout=json.dumps(snapshot['sharedAppEvidence']), stderr='')
        with mock.patch.object(collector.subprocess, 'run', return_value=response) as run:
            result = collector.collect_app_evidence(snapshot, [code], 'reader@example.test')
        self.assertEqual(result, snapshot['sharedAppEvidence'])
        script = run.call_args.kwargs['input']
        self.assertIn('scripts/export-report-evidence.ts', script)
        self.assertIn('deploy_pheno_lab', script)
        self.assertNotIn('publish-lab-report', script)
        self.assertEqual(run.call_args.args[0], ['bash', '-s'])
        self.assertEqual(run.call_args.kwargs['cwd'], collector.APP_ROOT)
        self.assertIn('./node_modules/.bin/tsx', script)
        self.assertIn('"experimentCodes":["' + code + '"]', script)

    def test_collector_does_not_silently_truncate_or_accept_failed_export(self):
        _, snapshot, _ = fixture()
        with self.assertRaises(ValueError):
            collector.collect_app_evidence(snapshot, [str(i) for i in range(251)], 'reader@example.test')
        with mock.patch.object(collector.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'private')):
            with self.assertRaises(RuntimeError):
                collector.collect_app_evidence(snapshot, [], 'reader@example.test')

    def test_primary_gate_accepts_same_app_facts_and_keeps_public_gate_active(self):
        document, snapshot, dossier = fixture()
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])
        self.assertTrue(public_fixture.gate.validate(document, snapshot, dossier)['passed'])

    def test_selection_definition_can_be_centralized_without_moving_case_decisions(self):
        document, snapshot, dossier = fixture()
        binding = document['evidenceMethodReview']['experiments'][0]
        binding['selectionSectionId'] = 'methods'
        document['languageReview'] = {'schemaVersion': 1, 'standardVersion': 'RESULT_JUDGMENT_ISSUE_NEXT_V1',
                                      'sharedMethodsSectionId': 'methods'}
        case = next(s for s in document['sections'] if s['id'] == binding['sectionId'])
        methods = {'id': 'methods', 'titleEn': 'Common methods', 'titleZh': '通用方法'}
        for lang in ('En', 'Zh'):
            paragraph = '<p>' + binding['selectionDefinition' + lang] + '</p>'
            case['body' + lang] = case['body' + lang].replace(paragraph, '')
            methods['body' + lang] = paragraph
        document['sections'].append(methods)
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])
        binding['selectionSectionId'] = 'absent'
        result = gate.validate(document, snapshot, dossier)
        self.assertFalse(result['passed'])
        self.assertIn('PRIMARY_SELECTION_DEFINITION_HAS_NO_SHARED_SECTION', {e['code'] for e in result['errors']})

    def test_centralized_selection_does_not_relax_case_or_numeric_binding(self):
        document, snapshot, dossier = fixture()
        binding = document['evidenceMethodReview']['experiments'][0]
        binding['selectionSectionId'] = 'projects'
        document['languageReview'] = {'schemaVersion': 1, 'standardVersion': 'RESULT_JUDGMENT_ISSUE_NEXT_V1',
                                      'sharedMethodsSectionId': 'other'}
        self.assertIn('PRIMARY_SELECTION_SECTION_DIFFERS_FROM_SHARED_METHODS',
                      {e['code'] for e in gate.validate(document, snapshot, dossier)['errors']})
        del document['languageReview']
        self.assertIn('PRIMARY_SHARED_SELECTION_REQUIRES_LANGUAGE_REVIEW',
                      {e['code'] for e in gate.validate(document, snapshot, dossier)['errors']})
        binding['comparisons'][0]['meanPce'] += 1
        self.assertIn('PRIMARY_NUMBERS_DIFFER_FROM_SHARED_DEVICE_FACTS',
                      {e['code'] for e in gate.validate(document, snapshot, dossier)['errors']})

    def test_wrong_device_count_delta_or_potential_is_blocked(self):
        for field, value in [('nDevices', 40), ('meanPce', 23), ('deltaBestPce', .1),
                             ('potential', 'NO_OBSERVED_BENEFIT'), ('evidenceConfidence', 'CONFIRMED')]:
            document, snapshot, dossier = fixture()
            document['evidenceMethodReview']['experiments'][0]['comparisons'][0][field] = value
            result = gate.validate(document, snapshot, dossier)
            self.assertFalse(result['passed'], field)

    def test_source_hash_scope_and_readable_conditions_are_required(self):
        document, snapshot, dossier = fixture()
        document['evidenceMethodReview']['experiments'][0]['sourceHash'] = 'b' * 64
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])
        document, snapshot, dossier = fixture()
        document['evidenceMethodReview']['experiments'][0]['conditionSummaryZh'] = '未在报告显示的条件'
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])
        document, snapshot, dossier = fixture()
        document['evidenceMethodReview']['selectionScope'] = 'NEW_THIS_WEEK'
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])

    def test_measured_decision_cannot_omit_all_numeric_comparison_bindings(self):
        document, snapshot, dossier = fixture()
        document['evidenceMethodReview']['experiments'][0]['comparisons'] = []
        result = gate.validate(document, snapshot, dossier)
        self.assertFalse(result['passed'])
        self.assertIn('MEASURED_PRIMARY_JUDGMENT_HAS_NO_BOUND_COMPARISON', {e['code'] for e in result['errors']})

    def test_ai_reuse_requires_reviewed_current_identical_selection(self):
        document, snapshot, dossier = fixture()
        binding = document['evidenceMethodReview']['experiments'][0]
        binding.update(aiInterpretationUsed=True, aiSourceHash='a' * 64)
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])
        ai = snapshot['sharedAppEvidence']['experiments'][0]['aiInterpretation']
        ai.update(available=True, sourceHashMatches=True, selectionMatchesPrimaryEvidence=True,
                  versionCurrent=True,
                  summary={'sourceHash': 'a' * 64, **ai['expectedVersions']}, reviewState='reviewed')
        dossier['primaryExperimentEvidence'] = shared.dossier_primary_evidence(snapshot)
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])
        ai['selectionMatchesPrimaryEvidence'] = False
        dossier['primaryExperimentEvidence'] = shared.dossier_primary_evidence(snapshot)
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])

    def test_reviewed_unchanged_source_does_not_reuse_an_old_analysis_version(self):
        document, snapshot, dossier = fixture()
        ai = snapshot['sharedAppEvidence']['experiments'][0]['aiInterpretation']
        ai.update(available=True, sourceHashMatches=True, selectionMatchesPrimaryEvidence=True,
                  versionCurrent=False, reviewState='reviewed',
                  summary={'sourceHash': 'a' * 64, **ai['expectedVersions']})
        ai['summary']['ruleVersion'] = 'superseded-rule'
        binding = document['evidenceMethodReview']['experiments'][0]
        binding.update(aiInterpretationUsed=True, aiSourceHash='a' * 64)
        dossier['primaryExperimentEvidence'] = shared.dossier_primary_evidence(snapshot)
        self.assertFalse(gate.validate(document, snapshot, dossier)['passed'])
        ai['versionCurrent'] = True
        with self.assertRaises(ValueError):
            shared.validate_export(snapshot['sharedAppEvidence'], snapshot)


if __name__ == '__main__':
    unittest.main()
