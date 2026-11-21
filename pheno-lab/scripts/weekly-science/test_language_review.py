#!/usr/bin/env python3
"""Synthetic clarity, visible ordering and scientific-scope review contracts."""
import copy
import html
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load('validate_language_review')
public_fixture = load('test_rd_document')


def fixture():
    case = {'experimentCode': 'SYNTHETIC-LANGUAGE-1', 'sectionId': 'case',
            'resultEvidenceStatus': 'OBSERVED', 'keyIssueStatus': 'SPECIFIC',
            'nextStepStatus': 'PROPOSED_NOT_EXECUTED',
            'resultEn': 'The candidate has higher average output than the reference.',
            'resultZh': '候选条件的平均输出高于对照。',
            'judgmentEn': 'Keep this condition for a fixed-condition repeat.',
            'judgmentZh': '保留此条件，开展固定条件复验。',
            'keyIssueEn': 'Only two devices were measured, so consistency needs a repeat.',
            'keyIssueZh': '目前只有两片样品，增效重复性仍需验证。',
            'nextStepEn': 'Repeat the candidate and reference in matched fabrication blocks.',
            'nextStepZh': '固定制备条件，分批复验候选条件与对照。'}
    statement = {'id': 'selection',
                 'textEn': 'Use one accepted complete result per device at the stated cutoff.',
                 'textZh': '按所列数据截止时间，每片器件采用一组完整结果。'}
    document = {'sections': [{'id': 'methods', 'titleEn': 'Common methods', 'titleZh': '统一说明'},
                             {'id': 'case', 'titleEn': 'Synthetic comparison', 'titleZh': '合成对比'}],
                'languageReview': {'schemaVersion': 1, 'standardVersion': gate.STANDARD,
                    'preparedBy': 'synthetic-author', 'sharedMethodsSectionId': 'methods',
                    'commonStatements': [statement], 'experiments': [case],
                    'peerReview': {'reviewer': 'synthetic-independent-reviewer', 'independent': True,
                        'reviewedAt': '2026-01-01T09:00:00+08:00', 'status': 'APPROVED',
                        'sourceReference': 'Synthetic reviewer receipt, not a real manuscript approval',
                        'reviewedExperimentCodes': [case['experimentCode']],
                        'checks': {key: True for key in gate.CHECKS}, 'concerns': []}}}
    for lang in ('En', 'Zh'):
        document['sections'][0]['body' + lang] = '<p>' + html.escape(statement['text' + lang]) + '</p>'
        document['sections'][1]['body' + lang] = ''.join('<p>' + html.escape(case[field + lang]) + '</p>'
            for field in ('result', 'judgment', 'keyIssue', 'nextStep'))
    return document


class LanguageReviewTests(unittest.TestCase):
    def invalid(self, document, code):
        result = gate.validate(document)
        self.assertFalse(result['passed'])
        self.assertIn(code, {e['code'] for e in result['errors']})

    def test_concrete_limitation_and_result_first_structure_are_accepted(self):
        result = gate.validate(fixture())
        self.assertTrue(result['passed'])
        self.assertFalse(result['scienceCertified'])
        self.assertFalse(result['languageQualityCertified'])

    def test_result_and_judgment_may_share_a_clear_paragraph(self):
        document = fixture()
        for lang in ('En', 'Zh'):
            case = document['languageReview']['experiments'][0]
            document['sections'][1]['body' + lang] = (
                '<p>' + case['result' + lang] + ' ' + case['judgment' + lang] + '</p>'
                '<p>' + case['keyIssue' + lang] + '</p><p>' + case['nextStep' + lang] + '</p>')
        self.assertTrue(gate.validate(document)['passed'])

    def test_uncertainty_words_are_not_banned_when_the_issue_is_specific(self):
        document = fixture()
        case = document['languageReview']['experiments'][0]
        old = case['keyIssueZh']
        case['keyIssueZh'] = '实际添加比例和刀头间隙尚未核实，目前无法证明哪个因素带来了效率变化。'
        document['sections'][1]['bodyZh'] = document['sections'][1]['bodyZh'].replace(old, case['keyIssueZh'])
        self.assertTrue(gate.validate(document)['passed'])

    def test_shared_methods_may_be_in_a_native_details_appendix(self):
        document = fixture()
        for lang in ('En', 'Zh'):
            document['sections'][0]['body' + lang] = '<details><summary>Methods</summary>' + document['sections'][0]['body' + lang] + '</details>'
        self.assertTrue(gate.validate(document)['passed'])

    def test_missing_envelope_is_required_standalone_not_assumed_approved(self):
        self.invalid({'sections': []}, 'MISSING_LANGUAGE_REVIEW')

    def test_result_limit_and_next_step_cannot_be_one_disclaimer_paragraph(self):
        document = fixture()
        for lang in ('En', 'Zh'):
            case = document['languageReview']['experiments'][0]
            document['sections'][1]['body' + lang] = '<p>' + ' '.join(case[f + lang] for f in ('result', 'judgment', 'keyIssue', 'nextStep')) + '</p>'
        self.invalid(document, 'RESULT_JUDGMENT_AND_LIMITATION_COLLAPSED')
        self.invalid(document, 'NEXT_STEP_NOT_SEPARATE_FROM_KEY_ISSUE')

    def test_limitations_before_result_fail_and_missing_result_is_not_silently_removed(self):
        document = fixture()
        case = document['languageReview']['experiments'][0]
        document['sections'][1]['bodyEn'] = ''.join('<p>' + case[f + 'En'] + '</p>' for f in ('keyIssue', 'result', 'judgment', 'nextStep'))
        self.invalid(document, 'EXPERIMENT_NOT_RESULT_JUDGMENT_ISSUE_NEXT_ORDER')
        document = fixture()
        del document['languageReview']['experiments'][0]['resultZh']
        self.invalid(document, 'MISSING_BILINGUAL_RESULT_FIRST_PASSAGE')

    def test_repeated_common_method_and_wrong_location_are_blocked(self):
        document = fixture()
        statement = document['languageReview']['commonStatements'][0]
        document['sections'][1]['bodyEn'] += '<p>' + statement['textEn'] + '</p>'
        self.invalid(document, 'COMMON_STATEMENT_NOT_CENTRALIZED_ONCE')
        document = fixture()
        document['sections'][0]['bodyEn'] = '<p>Other context</p>'
        document['sections'][1]['bodyEn'] += '<p>' + statement['textEn'] + '</p>'
        self.invalid(document, 'COMMON_STATEMENT_NOT_IN_SHARED_METHODS')

    def test_private_metadata_comments_or_hidden_prose_do_not_count_as_visible(self):
        for hidden in ('<!--{value}-->', '<span hidden>{value}</span>', '<span aria-hidden="true">{value}</span>',
                       '<span style="display:none">{value}</span>', '<script>{value}</script>'):
            document = fixture()
            case = document['languageReview']['experiments'][0]
            document['sections'][1]['bodyEn'] = document['sections'][1]['bodyEn'].replace(case['resultEn'], hidden.format(value=case['resultEn']))
            self.invalid(document, 'RESULT_FIRST_PASSAGE_NOT_VISIBLE')

    def test_no_issue_does_not_force_a_generic_disclaimer(self):
        document = fixture()
        case = document['languageReview']['experiments'][0]
        case['keyIssueStatus'] = 'NONE_DECISION_CRITICAL'
        for lang in ('En', 'Zh'):
            document['sections'][1]['body' + lang] = document['sections'][1]['body' + lang].replace('<p>' + case.pop('keyIssue' + lang) + '</p>', '')
        self.assertTrue(gate.validate(document)['passed'])
        case['keyIssueEn'] = 'More evidence is always needed.'
        self.invalid(document, 'UNNECESSARY_GENERIC_KEY_ISSUE')

    def test_reviewer_cannot_approve_deleting_scientific_scope(self):
        document = fixture()
        case = document['languageReview']['experiments'][0]
        old = case['judgmentEn']
        case['judgmentEn'] = 'The candidate has proved the proposed microscopic cause.'
        document['sections'][1]['bodyEn'] = document['sections'][1]['bodyEn'].replace(old, case['judgmentEn'])
        # A keyword scanner cannot certify this change. A real review records the
        # unsupported promotion from interpretation to fact and blocks publication.
        peer = document['languageReview']['peerReview']
        peer['checks']['evidenceScopePreserved'] = False
        peer['concerns'] = [{'severity': 'BLOCKING', 'issue': 'A conditional mechanism was rewritten as proven.', 'resolved': False}]
        self.invalid(document, 'MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK')
        self.invalid(document, 'UNRESOLVED_LANGUAGE_OR_SCOPE_CONCERN')

    def test_proposals_and_observation_status_must_be_explicit(self):
        document = fixture()
        document['languageReview']['experiments'][0]['nextStepStatus'] = 'EXECUTED'
        self.invalid(document, 'NEXT_STEP_MUST_REMAIN_REPORT_PROPOSAL')
        document = fixture()
        document['languageReview']['experiments'][0]['resultEvidenceStatus'] = 'PROVEN_CAUSE'
        self.invalid(document, 'RESULT_EVIDENCE_STATUS_NOT_EXPLICIT')

    def test_review_identity_time_coverage_and_all_checks_required(self):
        for field, value, code in [('reviewer', 'synthetic-author', 'MISSING_ACTUAL_INDEPENDENT_LANGUAGE_SCOPE_REVIEW'),
                                   ('reviewedAt', '2026-01-01T00:00:00', 'INVALID_LANGUAGE_REVIEW_TIME'),
                                   ('reviewedExperimentCodes', [], 'INCOMPLETE_LANGUAGE_REVIEW_COVERAGE'),
                                   ('independent', False, 'MISSING_ACTUAL_INDEPENDENT_LANGUAGE_SCOPE_REVIEW')]:
            document = fixture(); document['languageReview']['peerReview'][field] = value
            self.invalid(document, code)
        for check in gate.CHECKS:
            document = fixture(); document['languageReview']['peerReview']['checks'][check] = False
            self.invalid(document, 'MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK')

    def test_future_review_time_is_rejected(self):
        document = fixture()
        document['languageReview']['peerReview']['reviewedAt'] = '2999-01-01T00:00:00Z'
        self.invalid(document, 'LANGUAGE_REVIEW_DATE_IN_FUTURE')

    def test_every_primary_case_is_covered(self):
        document = fixture()
        document['evidenceMethodReview'] = {'experiments': [{'experimentCode': 'ANOTHER_CASE'}]}
        self.invalid(document, 'RESULT_FIRST_PRIMARY_CASE_COVERAGE_MISMATCH')

    def test_no_selected_case_does_not_force_a_padded_experiment(self):
        document = fixture()
        document['languageReview']['experiments'] = []
        document['languageReview']['peerReview']['reviewedExperimentCodes'] = []
        self.assertTrue(gate.validate(document)['passed'])
        document['evidenceMethodReview'] = {'experiments': [{'experimentCode': 'ACTUAL_SELECTED_CASE'}]}
        self.invalid(document, 'RESULT_FIRST_PRIMARY_CASE_COVERAGE_MISMATCH')

    def test_existing_public_gate_integrates_new_envelope_without_weakening_privacy(self):
        document, snapshot, dossier = public_fixture.fixture()
        language = fixture()
        for section in language['sections']:
            section['id'] = 'language-' + section['id']
        review = language['languageReview']
        review['sharedMethodsSectionId'] = 'language-methods'
        review['experiments'][0]['sectionId'] = 'language-case'
        document['sections'] += language['sections']
        document['languageReview'] = review
        self.assertTrue(public_fixture.gate.validate(document, snapshot, dossier)['passed'])
        document['sections'][-1]['bodyEn'] += '<script>window.synthetic = true</script>'
        self.assertFalse(public_fixture.gate.validate(document, snapshot, dossier)['passed'])
        document['sections'][-1]['bodyEn'] = document['sections'][-1]['bodyEn'].replace('<script>window.synthetic = true</script>', '')
        document['languageReview']['peerReview']['checks']['evidenceScopePreserved'] = False
        self.assertFalse(public_fixture.gate.validate(document, snapshot, dossier)['passed'])
        del document['languageReview']
        self.assertTrue(public_fixture.gate.validate(document, snapshot, dossier)['passed'])

    def test_bad_nested_shapes_fail_closed(self):
        for value in (None, [], {'languageReview': []}):
            self.assertFalse(gate.validate(value)['passed'])
        document = fixture(); document['languageReview']['experiments'][0]['experimentCode'] = []
        self.assertFalse(gate.validate(document)['passed'])

    def test_cli_writes_private_exclusive_result_and_never_rewrites_document(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'document.json'; result = root / 'result.json'
            source.write_text(json.dumps(fixture(), ensure_ascii=False)); before = source.read_bytes()
            command = [sys.executable, str(BASE / 'validate_language_review.py'), str(source), '--output', str(result)]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(result.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(run.stdout)['counts']['experiments'], 1)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
