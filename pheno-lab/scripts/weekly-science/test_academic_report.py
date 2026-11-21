#!/usr/bin/env python3
"""Synthetic academic manuscript acceptance contracts, not scientific validation."""
import copy
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('academic', BASE / 'validate_academic_report.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
spec = importlib.util.spec_from_file_location('public_fixture', BASE / 'test_rd_document.py')
public_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public_fixture)


def fixture():
    document, snapshot, dossier = public_fixture.fixture()
    snapshot['sampleMeasurements'][0].update(experimentCode='E-SYNTHETIC-1',
        metrics={'pce': 21.0, 'voc': 1.1, 'jsc': 24.0, 'ff': 79.0})
    main = ['abstract', 'questions', 'theory', 'methods', 'results-discussion', 'conclusions']
    appendices = ['appendix-continuity', 'appendix-project', 'appendix-history', 'appendix-inventory']
    english = '<p>This synthetic scientific section explains the evidence, assumptions, competing physical interpretations and a controlled test before drawing a limited research conclusion.</p>'
    chinese = '<p>这段合成科研文本解释观测证据、理论假设和相互竞争的物理机制，提出可区分机制的受控测试，并明确说明研究结论的适用限制。</p>'
    document['sections'] = [{'id': section, 'titleEn': section.title(), 'titleZh': '合成科研分析',
                            'bodyEn': english, 'bodyZh': chinese} for section in main + appendices]
    theory = document['sections'][2]
    theory['bodyEn'] += '<a href="' + public_fixture.PUBLIC_URL + '">Primary scientific reference</a>'
    theory['bodyZh'] += '<a href="' + public_fixture.PUBLIC_URL + '">原始科研文献</a>'
    document['rdReview']['sectionIds'] = {'projects': 'appendix-project', 'performance': 'results-discussion',
        'reproducibility': 'methods', 'continuity': 'appendix-continuity', 'mechanisms': 'results-discussion',
        'priorities': 'conclusions', 'limitations': 'conclusions', 'literature': 'theory'}
    document['rdReview']['priorityActions'][0]['sectionId'] = 'conclusions'
    document['rdReview']['mechanismCards'][0]['sectionId'] = 'results-discussion'
    document['rdReview']['chemistryLimitations'][0]['sectionId'] = 'conclusions'
    cases = []
    for index in range(4):
        cases.append({'id': 'case-' + str(index), 'sectionId': 'results-discussion', 'evidenceIds': ['scan-001'],
            'theoryModelIds': ['model-diode'],
            'metrics': [{'name': name, 'unit': unit, 'status': 'OBSERVED', 'evidenceIds': ['scan-001'],
                         'observationEn': 'Recorded component requires a matched mechanistic contrast.',
                         'observationZh': '记录到的器件分量需要通过匹配的机制对照验证。'} for name, unit in gate.METRIC_UNITS.items()],
            'primaryMechanism': {'id': 'recombination', 'statementEn': 'Reduced interfacial nonradiative recombination is a testable hypothesis.',
                                 'statementZh': '界面非辐射复合减少是需要验证的假设。'},
            'competingCauses': [{'id': 'conditioning', 'statementEn': 'Different scan conditioning could instead change apparent performance.',
                                 'statementZh': '扫描预处理条件差异也可能改变表观性能。'}],
            'predictions': [{'mechanismId': 'recombination', 'measurement': 'Matched illumination QFLS',
                             'signatureEn': 'A reproducible increase survives matched preconditioning.',
                             'signatureZh': '在匹配预处理后仍可重复观察到提高。'},
                            {'mechanismId': 'conditioning', 'measurement': 'Matched illumination QFLS',
                             'signatureEn': 'No persistent increase remains after matched preconditioning.',
                             'signatureZh': '匹配预处理后不再存在持续提高。'}],
            'discriminatingExperimentEn': 'Match illumination, substrate and preconditioning, then measure both optical and electrical response.',
            'discriminatingExperimentZh': '匹配光照、基底和预处理条件，同时测量光学和电学响应。',
            'decisionCriterionEn': 'Advance only if the predicted optical signature survives the matched contrast; otherwise revise the cause.',
            'decisionCriterionZh': '仅在匹配对照后仍观察到预测光学特征时推进，否则修正原因假设。',
            'evidenceStatus': 'TESTABLE_HYPOTHESIS'})
    document['academicReview'] = {'schemaVersion': 1, 'preparedBy': 'Synthetic author',
        'sectionIds': {'abstract': 'abstract', 'questions': 'questions', 'theory': 'theory', 'methods': 'methods',
            'resultsDiscussion': 'results-discussion', 'conclusions': 'conclusions',
            'appendixContinuity': 'appendix-continuity', 'appendixProjectProgress': 'appendix-project',
            'appendixEvidenceHistory': 'appendix-history', 'appendixInventory': 'appendix-inventory'},
        'scientificMainSectionIds': main, 'appendixSectionIds': appendices,
        'authorAttestation': {key: True for key in gate.AUTHOR_MARKS},
        'researchQuestions': [{'id': 'question-1', 'sectionId': 'questions',
                               'questionEn': 'Which controlled signatures distinguish the proposed interfacial mechanism?',
                               'questionZh': '哪些受控测量特征能区分提出的界面机制？'}],
        'theoryModels': [{'id': 'model-diode', 'sectionId': 'theory',
            'nameEn': 'Conditional diode framework', 'nameZh': '条件性二极管理论框架',
            'relationEn': 'A lower dark recombination current can raise open-circuit voltage under fixed conditions.',
            'relationZh': '固定其他条件时，较低的暗复合电流可能提高开路电压。',
            'variables': [{'symbol': 'Voc', 'meaningEn': 'Open-circuit voltage', 'meaningZh': '开路电压', 'unit': 'V', 'status': 'MEASURED'},
                          {'symbol': 'J0', 'meaningEn': 'Dark recombination current density', 'meaningZh': '暗复合电流密度', 'unit': 'mA/cm²', 'status': 'LATENT'}],
            'assumptionsEn': ['Matched illumination and temperature; no unverified series topology comparison.'],
            'assumptionsZh': ['光照和温度匹配，且不比较未确认的串联器件拓扑。'],
            'explanationEn': 'The framework links a loss channel to a measurable component but does not uniquely identify the cause.',
            'explanationZh': '该框架将损失通道与可测分量关联，但不能唯一确定原因。',
            'localApplicabilityEn': 'The assumptions require additional controlled measurements; no parameter was fitted.',
            'localApplicabilityZh': '这些假设需要额外受控测量验证，目前未进行参数拟合。',
            'publicSourceUrls': [public_fixture.PUBLIC_URL], 'evidenceStatus': 'EXPLANATORY_NOT_FITTED'}],
        'coreCases': cases,
        'peerReview': {'reviewer': 'Independent synthetic reviewer', 'reviewedAt': '2026-01-31T01:09:00Z',
            'independent': True, 'status': 'APPROVED', 'sourceReference': 'synthetic-scientific-review.json',
            'reviewedCaseIds': [case['id'] for case in cases], 'checks': {key: True for key in gate.PEER_CHECKS}, 'concerns': []}}
    return document, snapshot, dossier


class AcademicGate(unittest.TestCase):
    def invalid(self, document, snapshot, dossier, code):
        result = gate.validate(document, snapshot, dossier)
        self.assertFalse(result['passed'])
        self.assertIn(code, {error['code'] for error in result['errors']})
        self.assertNotIn(public_fixture.PRIVATE_LONG, json.dumps(result))

    def test_complete_scientific_contract_passes_without_claiming_quality_certification(self):
        result = gate.validate(*fixture())
        self.assertTrue(result['passed'], result['errors'])
        self.assertEqual(result['counts']['coreScientificCases'], 4)
        self.assertFalse(result['scienceCertified'])
        self.assertIn('No word count', result['limitations'][1])

    def decision_fixture(self):
        document, snapshot, dossier = fixture()
        review = document['academicReview']
        review['reportStyle'] = gate.DECISION_STYLE
        review['authorAttestation'] = {key: True for key in gate.DECISION_AUTHOR_MARKS}
        review['coreCases'] = review['coreCases'][:1]
        review['peerReview']['reviewedCaseIds'] = [review['coreCases'][0]['id']]
        document['rdReview']['sectionIds']['projects'] = 'abstract'
        document['rdReview']['sectionIds']['continuity'] = 'results-discussion'
        return document, snapshot, dossier

    def test_decision_style_accepts_project_decisions_before_focused_cases_without_padding(self):
        result = gate.validate(*self.decision_fixture())
        self.assertTrue(result['passed'], result['errors'])
        self.assertEqual(result['counts']['coreScientificCases'], 1)

    def test_decision_style_retains_review_metrics_and_privacy_requirements(self):
        document, snapshot, dossier = self.decision_fixture()
        document['academicReview']['peerReview']['independent'] = False
        self.invalid(document, snapshot, dossier, 'SCIENTIFIC_REVIEWER_NOT_INDEPENDENT')
        document, snapshot, dossier = self.decision_fixture()
        document['academicReview']['coreCases'][0]['metrics'].pop()
        self.invalid(document, snapshot, dossier, 'INCOMPLETE_PCE_VOC_JSC_FF_DISCUSSION')

    def test_decision_style_requires_explicit_style_attestation_and_main_project_judgment(self):
        document, snapshot, dossier = self.decision_fixture()
        document['academicReview']['authorAttestation']['theoryIsCaseSpecific'] = False
        self.invalid(document, snapshot, dossier, 'MISSING_SCIENTIFIC_MAIN_NARRATIVE_ATTESTATION')
        document, snapshot, dossier = self.decision_fixture()
        document['rdReview']['sectionIds']['projects'] = 'appendix-project'
        self.invalid(document, snapshot, dossier, 'PROJECT_DECISIONS_MUST_LEAD_MAIN_RESULTS')
        document, snapshot, dossier = fixture()
        document['academicReview']['reportStyle'] = 'UNREVIEWED_SHORTCUT'
        self.invalid(document, snapshot, dossier, 'UNKNOWN_ACADEMIC_REPORT_STYLE')

    def test_chronology_or_inventory_cannot_replace_scientific_main_sections(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['sectionIds']['theory'] = 'appendix-history'
        self.invalid(document, snapshot, dossier, 'SCIENTIFIC_ROLES_OUTSIDE_MAIN_BODY')
        document, snapshot, dossier = fixture()
        document['sections'] = document['sections'][-1:] + document['sections'][:-1]
        self.invalid(document, snapshot, dossier, 'APPENDICES_MUST_FOLLOW_SCIENTIFIC_CONCLUSIONS')
        document, snapshot, dossier = fixture()
        document['rdReview']['sectionIds']['projects'] = 'abstract'
        self.invalid(document, snapshot, dossier, 'MANAGEMENT_HISTORY_REMAINS_IN_MAIN_NARRATIVE')

    def test_theory_requires_variables_units_assumptions_explanation_and_citations(self):
        changes = [
            (lambda d: d['academicReview']['theoryModels'][0].update(variables=[]), 'UNDEFINED_THEORY_VARIABLES'),
            (lambda d: d['academicReview']['theoryModels'][0]['variables'][0].update(unit=''), 'UNDEFINED_OR_DUPLICATE_VARIABLE_MEANING_UNIT_STATUS'),
            (lambda d: d['academicReview']['theoryModels'][0].update(assumptionsZh=[]), 'MISSING_OR_UNBALANCED_MODEL_ASSUMPTIONS'),
            (lambda d: d['academicReview']['theoryModels'][0].update(explanationEn=''), 'INCOMPLETE_BILINGUAL_THEORY'),
            (lambda d: d['academicReview']['theoryModels'][0].update(publicSourceUrls=['https://example.com/not-cited']), 'THEORY_REFERENCE_NOT_PUBLIC_OR_CITED'),
            (lambda d: d['academicReview']['theoryModels'][0].update(evidenceStatus='QUANTUM_PROOF_FROM_GRAPH'), 'MISSING_THEORY_INFERENCE_STATUS')]
        for change, code in changes:
            document, snapshot, dossier = fixture()
            change(document)
            self.invalid(document, snapshot, dossier, code)

    def test_fit_label_requires_source_bound_validation_and_bilingual_limits(self):
        document, snapshot, dossier = fixture()
        model = document['academicReview']['theoryModels'][0]
        model['evidenceStatus'] = 'FITTED_WITH_VALIDATION'
        self.invalid(document, snapshot, dossier, 'MODEL_FIT_LACKS_REVIEWED_VALIDATION_LIMITS')
        model.update(validationEvidenceIds=['scan-001'], validationLimitsEn='A synthetic validation annotation, not a statistical result.',
                     validationLimitsZh='合成验证说明，不代表真实统计结果。')
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_four_scientific_cases_and_linked_theory_are_required(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'].pop()
        self.invalid(document, snapshot, dossier, 'FEWER_THAN_FOUR_CORE_SCIENTIFIC_CASES')
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][0]['theoryModelIds'] = ['unknown-theory']
        self.invalid(document, snapshot, dossier, 'SCIENTIFIC_CASE_LACKS_LINKED_THEORY')

    def test_all_component_metrics_must_be_discussed_with_evidence_and_units(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][0]['metrics'].pop()
        self.invalid(document, snapshot, dossier, 'INCOMPLETE_PCE_VOC_JSC_FF_DISCUSSION')
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][0]['metrics'][3]['unit'] = 'fraction'
        self.invalid(document, snapshot, dossier, 'COMPONENT_UNITS_SILENTLY_CHANGED')
        document, snapshot, dossier = fixture()
        snapshot['sampleMeasurements'][0]['metrics'].pop('voc')
        self.invalid(document, snapshot, dossier, 'OBSERVED_COMPONENT_HAS_NO_RECORDED_NUMERIC_EVIDENCE')

    def test_missing_or_unverified_components_remain_explicit_without_fabrication(self):
        document, snapshot, dossier = fixture()
        snapshot['sampleMeasurements'][0]['metrics'].pop('voc')
        for case in document['academicReview']['coreCases']:
            case['metrics'][1].update(status='MISSING', evidenceIds=[])
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])
        document, snapshot, dossier = fixture()
        for case in document['academicReview']['coreCases']:
            case['metrics'][1].update(status='UNVERIFIED_NORMALIZATION', unit='V with unverified series topology')
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_competing_physical_cause_and_distinct_shared_measurement_signatures_required(self):
        document, snapshot, dossier = fixture()
        case = document['academicReview']['coreCases'][0]
        case['competingCauses'] = []
        self.invalid(document, snapshot, dossier, 'MISSING_COMPETING_PHYSICAL_CAUSE')
        document, snapshot, dossier = fixture()
        case = document['academicReview']['coreCases'][0]
        case['predictions'][1]['measurement'] = 'A completely different observable'
        self.invalid(document, snapshot, dossier, 'NO_DISTINCT_FALSIFIABLE_COMMON_MEASUREMENT_SIGNATURES')
        document, snapshot, dossier = fixture()
        case = document['academicReview']['coreCases'][0]
        case['predictions'][1].update(signatureEn=case['predictions'][0]['signatureEn'], signatureZh=case['predictions'][0]['signatureZh'])
        self.invalid(document, snapshot, dossier, 'NO_DISTINCT_FALSIFIABLE_COMMON_MEASUREMENT_SIGNATURES')

    def test_all_competing_causes_need_predictions_and_bilingual_decisions(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][0]['predictions'].pop()
        self.invalid(document, snapshot, dossier, 'EACH_COMPETING_CAUSE_NEEDS_PREDICTED_OBSERVABLE')
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][0]['decisionCriterionZh'] = ''
        self.invalid(document, snapshot, dossier, 'MISSING_BILINGUAL_DISCRIMINATOR_OR_DECISION')
        document, snapshot, dossier = fixture()
        case = document['academicReview']['coreCases'][0]
        case['competingCauses'].append({'id': 'another-cause', 'statementEn': 'Another plausible unresolved cause.',
                                        'statementZh': '另一个合理但尚未排除的原因。'})
        prediction = copy.deepcopy(case['predictions'][0])
        prediction['mechanismId'] = 'another-cause'
        case['predictions'].append(prediction)
        self.invalid(document, snapshot, dossier, 'NO_DISTINCT_FALSIFIABLE_COMMON_MEASUREMENT_SIGNATURES')

    def test_independent_approved_real_review_evidence_is_mandatory(self):
        for change, code in [
            (lambda d: d['academicReview'].pop('peerReview'), 'MISSING_INDEPENDENT_SCIENTIFIC_PEER_REVIEW'),
            (lambda d: d['academicReview']['peerReview'].update(reviewer='Synthetic author'), 'SCIENTIFIC_REVIEWER_NOT_INDEPENDENT'),
            (lambda d: d['academicReview']['peerReview'].update(status='PENDING'), 'SCIENTIFIC_PEER_REVIEW_NOT_APPROVED_OR_EVIDENCED'),
            (lambda d: d['academicReview']['peerReview'].update(sourceReference=''), 'SCIENTIFIC_PEER_REVIEW_NOT_APPROVED_OR_EVIDENCED'),
            (lambda d: d['academicReview']['peerReview'].update(reviewedAt='2100-01-01T00:00:00Z'), 'SCIENTIFIC_REVIEW_DATE_IN_FUTURE'),
            (lambda d: d['academicReview']['peerReview']['reviewedCaseIds'].pop(), 'SCIENTIFIC_PEER_REVIEW_DOES_NOT_COVER_ALL_CASES'),
            (lambda d: d['academicReview']['peerReview']['checks'].update(theoryAssumptions=False), 'INCOMPLETE_SCIENTIFIC_PEER_REVIEW_CHECKS')]:
            document, snapshot, dossier = fixture()
            change(document)
            self.invalid(document, snapshot, dossier, code)

    def test_unresolved_scientific_blocker_cannot_be_overridden_by_checks(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['peerReview']['concerns'] = [{'severity': 'BLOCKING', 'issue': 'Unverified normalization changes the inference.', 'resolved': False}]
        self.invalid(document, snapshot, dossier, 'UNRESOLVED_SCIENTIFIC_PEER_REVIEW_BLOCKER')
        document['academicReview']['peerReview']['concerns'][0]['resolved'] = True
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_privacy_gate_still_blocks_graph_content_in_academic_manuscript(self):
        document, snapshot, dossier = fixture()
        document['sections'][4]['bodyEn'] += '<p>' + public_fixture.PRIVATE_LONG + '</p>'
        self.invalid(document, snapshot, dossier, 'PUBLIC_GATE_PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_controlled_support_requires_control_explanation_and_declared_review(self):
        document, snapshot, dossier = fixture()
        case = document['academicReview']['coreCases'][0]
        case['evidenceStatus'] = 'CONTROLLED_SUPPORT'
        self.invalid(document, snapshot, dossier, 'CONTROLLED_SUPPORT_HAS_NO_CONTROL_JUSTIFICATION')
        case.update(controlledSupportJustificationEn='Synthetic explicit control annotation; not a real executed study.',
                    controlledSupportJustificationZh='合成受控说明，不表示真实实验已执行。')
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_duplicate_ids_and_malformed_nested_shapes_fail_closed(self):
        document, snapshot, dossier = fixture()
        document['academicReview']['coreCases'][1]['id'] = document['academicReview']['coreCases'][0]['id']
        self.invalid(document, snapshot, dossier, 'DUPLICATE_ACADEMIC_ITEM_ID')
        document, snapshot, dossier = fixture()
        document['academicReview']['theoryModels'][0]['variables'][0]['symbol'] = {'bad': public_fixture.PRIVATE_LONG}
        result = gate.validate(document, snapshot, dossier)
        self.assertFalse(result['passed'])
        self.assertNotIn(public_fixture.PRIVATE_LONG, json.dumps(result))

    def test_cli_returns_private_aggregate_without_certifying_science(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            paths = [root / name for name in ('document.json', 'snapshot.json', 'dossier.json')]
            for path, value in zip(paths, fixture()):
                path.write_text(json.dumps(value))
            output = root / 'gate.json'
            result = subprocess.run([sys.executable, str(BASE / 'validate_academic_report.py'), *map(str, paths), '--output', str(output)], capture_output=True, text=True, check=True)
            self.assertTrue(json.loads(result.stdout)['passed'])
            self.assertFalse(json.loads(result.stdout)['scienceCertified'])
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertNotIn(public_fixture.PRIVATE_LONG, result.stdout + output.read_text())


if __name__ == '__main__':
    unittest.main()
