#!/usr/bin/env python3
"""Academic report contract gate; independent scientific review remains mandatory.

Usage: validate_academic_report.py DOCUMENT SNAPSHOT DOSSIER [--output PRIVATE_GATE]
This supplements existing privacy/evidence gates. It does not measure writing
quality, certify equations, or replace an actual independent scientific review.
"""
import argparse
from collections import Counter
import datetime as dt
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('academic_public_gate', BASE / 'validate_rd_document.py')
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)
MAIN_ROLES = {'abstract', 'questions', 'theory', 'methods', 'resultsDiscussion', 'conclusions'}
APPENDIX_ROLES = {'appendixContinuity', 'appendixProjectProgress', 'appendixEvidenceHistory', 'appendixInventory'}
AUTHOR_MARKS = {'scienceDominatesMainBody', 'managementHistoryConfinedToAppendix', 'noInventoryAsMainNarrative'}
DECISION_STYLE = 'DECISION_LED_EXPERIMENT_REVIEW'
DECISION_AUTHOR_MARKS = {'scienceDominatesMainBody', 'projectDecisionsLeadMainBody',
                         'theoryIsCaseSpecific', 'noInventoryAsMainNarrative'}
PEER_CHECKS = {'theoryAssumptions', 'unitsNormalization', 'falsifiability', 'discrimination', 'decisionCriteria',
               'sourcesPrimaryAndRelevant', 'causalityLimits', 'scienceDominatesMainBody', 'privacy', 'bilingualScientificEquivalence'}
METRIC_UNITS = {'pce': '%', 'voc': 'V', 'jsc': 'mA/cm²', 'ff': '%'}
CASE_STATUSES = {'TESTABLE_HYPOTHESIS', 'EXPLORATORY_ASSOCIATION', 'CONTROLLED_SUPPORT'}
VARIABLE_STATUSES = {'MEASURED', 'CONTROLLED', 'LATENT', 'DERIVED', 'UNVERIFIED', 'KNOWN_CONSTANT'}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value, allow_empty=False):
    return isinstance(value, list) and (allow_empty or bool(value)) and all(text(v) for v in value) and len(value) == len(set(value))


def bilingual(item, base):
    return text(item.get(base + 'En')) and text(item.get(base + 'Zh'))


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalized(value):
    return re.sub(r'\s+', ' ', public.decoded(value).strip()).casefold()


def observed_metrics(snapshot, dossier):
    available = {}
    for name in ('sampleMeasurements', 'historicalSampleMeasurements'):
        for scan in snapshot.get(name, []):
            metrics = {key for key in METRIC_UNITS if finite((scan.get('metrics') or {}).get(key))}
            if scan.get('measurementAlias'):
                available.setdefault(scan['measurementAlias'], set()).update(metrics)
            if scan.get('experimentCode'):
                available.setdefault(scan['experimentCode'], set()).update(metrics)
    for project in dossier.get('projects', []):
        for stratum in project.get('strata', []):
            outcomes = stratum.get('inferenceOutcomes') or stratum
            metrics = {name for name in METRIC_UNITS
                       if isinstance((outcomes.get('metrics') or {}).get(name), dict)
                       and finite(outcomes['metrics'][name].get('median'))
                       and outcomes['metrics'][name].get('nSamples', 0) > 0}
            if stratum.get('stratumId'):
                available.setdefault(stratum['stratumId'], set()).update(metrics)
    return available


def _validate(document, snapshot, dossier):
    result = public.validate(document, snapshot, dossier)
    errors = [{'code': 'PUBLIC_GATE_' + e['code'], 'path': e['path']} for e in result['errors']]
    def fail(code, path):
        errors.append({'code': code, 'path': path})
    review = document.get('academicReview')
    if not isinstance(review, dict) or review.get('schemaVersion') != 1:
        fail('MISSING_ACADEMIC_REVIEW', 'academicReview')
        review = {}
    style = review.get('reportStyle')
    decision_led = style == DECISION_STYLE
    if style not in (None, DECISION_STYLE):
        fail('UNKNOWN_ACADEMIC_REPORT_STYLE', 'academicReview.reportStyle')
    sections = {s['id']: s for s in document.get('sections', []) if isinstance(s, dict) and text(s.get('id'))}
    positions = {s['id']: index for index, s in enumerate(document.get('sections', [])) if isinstance(s, dict) and text(s.get('id'))}
    hrefs = set()
    for section in sections.values():
        for lang in ('En', 'Zh'):
            _, parsed = public.html_plain(section.get('body' + lang, ''))
            hrefs |= parsed.hrefs
    roles = review.get('sectionIds')
    if not isinstance(roles, dict) or not (MAIN_ROLES | APPENDIX_ROLES).issubset(roles):
        fail('MISSING_ACADEMIC_MANUSCRIPT_ROLES', 'academicReview.sectionIds')
        roles = {}
    for role, section_id in roles.items():
        if section_id not in sections:
            fail('UNKNOWN_ACADEMIC_SECTION', 'academicReview.sectionIds.' + role)
    main = review.get('scientificMainSectionIds')
    appendices = review.get('appendixSectionIds')
    if not strings(main) or not set(main).issubset(sections):
        fail('INVALID_SCIENTIFIC_MAIN_SECTIONS', 'academicReview.scientificMainSectionIds')
        main = []
    if not strings(appendices) or not set(appendices).issubset(sections):
        fail('INVALID_APPENDIX_SECTIONS', 'academicReview.appendixSectionIds')
        appendices = []
    if set(main) & set(appendices):
        fail('SCIENCE_APPENDIX_SECTION_OVERLAP', 'academicReview')
    if not {roles.get(role) for role in MAIN_ROLES}.issubset(main):
        fail('SCIENTIFIC_ROLES_OUTSIDE_MAIN_BODY', 'academicReview.scientificMainSectionIds')
    if not {roles.get(role) for role in APPENDIX_ROLES}.issubset(appendices):
        fail('HISTORY_INVENTORY_NOT_CONFINED_TO_APPENDIX', 'academicReview.appendixSectionIds')
    if main and appendices and max(positions[s] for s in main) >= min(positions[s] for s in appendices):
        fail('APPENDICES_MUST_FOLLOW_SCIENTIFIC_CONCLUSIONS', 'academicReview.appendixSectionIds')
    rd_roles = (document.get('rdReview') or {}).get('sectionIds') or {}
    if (document.get("decisionReview", {}).get("priorIssueScope", {}).get("presentation") == "PROJECT_STATUS_REGISTER_V1" and
            (roles.get("appendixContinuity") != "prior-action-review" or rd_roles.get("continuity") != "prior-action-review")):
        fail("PROJECT_QUESTION_CONTINUITY_MISSING_FROM_APPENDIX", "academicReview.sectionIds.appendixContinuity")
    if not decision_led and any(rd_roles.get(role) not in appendices for role in ('projects', 'continuity')):
        fail('MANAGEMENT_HISTORY_REMAINS_IN_MAIN_NARRATIVE', 'rdReview.sectionIds')
    if decision_led and (rd_roles.get('projects') not in main or
                         positions.get(rd_roles.get('projects'), math.inf) >
                         positions.get(roles.get('resultsDiscussion'), -1)):
        fail('PROJECT_DECISIONS_MUST_LEAD_MAIN_RESULTS', 'rdReview.sectionIds.projects')
    author = review.get('preparedBy')
    if not text(author):
        fail('MISSING_SCIENTIFIC_AUTHOR', 'academicReview.preparedBy')
    attestation = review.get('authorAttestation')
    required_marks = DECISION_AUTHOR_MARKS if decision_led else AUTHOR_MARKS
    if not isinstance(attestation, dict) or any(attestation.get(mark) is not True for mark in required_marks):
        fail('MISSING_SCIENTIFIC_MAIN_NARRATIVE_ATTESTATION', 'academicReview.authorAttestation')
    known_evidence = public.evidence_ids(snapshot, dossier)
    metric_evidence = observed_metrics(snapshot, dossier)
    def refs(values, path, allow_empty=False):
        if not strings(values, allow_empty=allow_empty) or not set(values).issubset(known_evidence):
            fail('UNKNOWN_OR_MISSING_ACADEMIC_EVIDENCE_IDS', path)
    all_ids = set()
    def identity(item, path):
        identifier = item.get('id')
        if not text(identifier) or not public.IDENTIFIER.fullmatch(identifier):
            fail('INVALID_ACADEMIC_ITEM_ID', path)
        elif identifier in all_ids:
            fail('DUPLICATE_ACADEMIC_ITEM_ID', path)
        else:
            all_ids.add(identifier)
        if item.get('sectionId') not in main:
            fail('SCIENTIFIC_ITEM_NOT_IN_MAIN_BODY', path + '.sectionId')
    questions = review.get('researchQuestions')
    if not isinstance(questions, list) or not questions:
        fail('MISSING_RESEARCH_QUESTIONS', 'academicReview.researchQuestions')
        questions = []
    for index, question in enumerate(questions):
        path = f'academicReview.researchQuestions[{index}]'
        identity(question, path)
        if not bilingual(question, 'question'):
            fail('INCOMPLETE_BILINGUAL_RESEARCH_QUESTION', path)
    models = review.get('theoryModels')
    if not isinstance(models, list) or not models:
        fail('MISSING_THEORETICAL_FRAMEWORK', 'academicReview.theoryModels')
        models = []
    model_ids = set()
    for index, model in enumerate(models):
        path = f'academicReview.theoryModels[{index}]'
        identity(model, path)
        model_ids.add(model.get('id'))
        for field in ('name', 'relation', 'explanation', 'localApplicability'):
            if not bilingual(model, field):
                fail('INCOMPLETE_BILINGUAL_THEORY', path + '.' + field)
        assumptions = (model.get('assumptionsEn'), model.get('assumptionsZh'))
        if not all(strings(values) for values in assumptions) or len(assumptions[0]) != len(assumptions[1]):
            fail('MISSING_OR_UNBALANCED_MODEL_ASSUMPTIONS', path)
        variables = model.get('variables')
        if not isinstance(variables, list) or not variables:
            fail('UNDEFINED_THEORY_VARIABLES', path)
            variables = []
        symbols = set()
        for vi, variable in enumerate(variables):
            vp = path + f'.variables[{vi}]'
            symbol = variable.get('symbol')
            if not text(symbol) or symbol in symbols or not bilingual(variable, 'meaning') or not text(variable.get('unit')) or variable.get('status') not in VARIABLE_STATUSES:
                fail('UNDEFINED_OR_DUPLICATE_VARIABLE_MEANING_UNIT_STATUS', vp)
            symbols.add(symbol)
        sources = model.get('publicSourceUrls')
        if not strings(sources):
            fail('MISSING_THEORY_PRIMARY_REFERENCES', path)
            sources = []
        for url in sources:
            if not public.public_https(url) or public.decoded(url) not in hrefs:
                fail('THEORY_REFERENCE_NOT_PUBLIC_OR_CITED', path)
        status = model.get('evidenceStatus')
        if status not in {'EXPLANATORY_NOT_FITTED', 'FITTED_WITH_VALIDATION'}:
            fail('MISSING_THEORY_INFERENCE_STATUS', path)
        if status == 'FITTED_WITH_VALIDATION':
            refs(model.get('validationEvidenceIds'), path + '.validationEvidenceIds')
            if not bilingual(model, 'validationLimits'):
                fail('MODEL_FIT_LACKS_REVIEWED_VALIDATION_LIMITS', path)
    cases = review.get('coreCases')
    minimum_cases = 1 if decision_led else 4
    if not isinstance(cases, list) or len(cases) < minimum_cases:
        fail('MISSING_DECISION_RELEVANT_SCIENTIFIC_CASES' if decision_led else
             'FEWER_THAN_FOUR_CORE_SCIENTIFIC_CASES', 'academicReview.coreCases')
        cases = cases if isinstance(cases, list) else []
    case_ids = set()
    for index, case in enumerate(cases):
        path = f'academicReview.coreCases[{index}]'
        identity(case, path)
        case_ids.add(case.get('id'))
        refs(case.get('evidenceIds'), path + '.evidenceIds')
        links = case.get('theoryModelIds')
        if not strings(links) or not set(links).issubset(model_ids):
            fail('SCIENTIFIC_CASE_LACKS_LINKED_THEORY', path)
        metrics = case.get('metrics')
        if not isinstance(metrics, list):
            fail('SCIENTIFIC_CASE_LACKS_COMPONENT_METRICS', path)
            metrics = []
        names = set()
        for mi, metric in enumerate(metrics):
            mp = path + f'.metrics[{mi}]'
            name, status = metric.get('name'), metric.get('status')
            if name not in METRIC_UNITS or name in names:
                fail('UNKNOWN_OR_DUPLICATE_COMPONENT_METRIC', mp)
            names.add(name)
            if status not in {'OBSERVED', 'MISSING', 'UNVERIFIED_NORMALIZATION'} or not text(metric.get('unit')) or not bilingual(metric, 'observation'):
                fail('UNEXPLAINED_COMPONENT_METRIC_STATUS', mp)
            if status != 'UNVERIFIED_NORMALIZATION' and metric.get('unit') != METRIC_UNITS.get(name):
                fail('COMPONENT_UNITS_SILENTLY_CHANGED', mp)
            refs(metric.get('evidenceIds'), mp + '.evidenceIds', allow_empty=status == 'MISSING')
            if status == 'OBSERVED' and not any(name in metric_evidence.get(evidence, set()) for evidence in metric.get('evidenceIds', [])):
                fail('OBSERVED_COMPONENT_HAS_NO_RECORDED_NUMERIC_EVIDENCE', mp)
        if names != set(METRIC_UNITS):
            fail('INCOMPLETE_PCE_VOC_JSC_FF_DISCUSSION', path)
        primary = case.get('primaryMechanism')
        competitors = case.get('competingCauses')
        if not isinstance(primary, dict) or not text(primary.get('id')) or not bilingual(primary, 'statement'):
            fail('MISSING_BILINGUAL_PRIMARY_MECHANISM', path)
            primary = {}
        if not isinstance(competitors, list) or not competitors:
            fail('MISSING_COMPETING_PHYSICAL_CAUSE', path)
            competitors = []
        mechanisms = {primary.get('id')} if primary.get('id') else set()
        for ci, competitor in enumerate(competitors):
            if not text(competitor.get('id')) or competitor.get('id') in mechanisms or not bilingual(competitor, 'statement'):
                fail('INCOMPLETE_OR_DUPLICATE_COMPETING_CAUSE', path + f'.competingCauses[{ci}]')
            mechanisms.add(competitor.get('id'))
        predictions = case.get('predictions')
        if not isinstance(predictions, list) or not predictions:
            fail('MISSING_FALSIFIABLE_MEASUREMENT_PREDICTIONS', path)
            predictions = []
        by_measurement = {}
        predicted_mechanisms = set()
        for pi, prediction in enumerate(predictions):
            pp = path + f'.predictions[{pi}]'
            mechanism, measurement = prediction.get('mechanismId'), prediction.get('measurement')
            if mechanism not in mechanisms or not text(measurement) or not bilingual(prediction, 'signature'):
                fail('INCOMPLETE_OR_UNBOUND_MEASUREMENT_SIGNATURE', pp)
                continue
            predicted_mechanisms.add(mechanism)
            row = by_measurement.setdefault(normalized(measurement), {})
            if mechanism in row:
                fail('DUPLICATE_MECHANISM_MEASUREMENT_SIGNATURE', pp)
            row[mechanism] = (normalized(prediction['signatureEn']), normalized(prediction['signatureZh']))
        if predicted_mechanisms != mechanisms:
            fail('EACH_COMPETING_CAUSE_NEEDS_PREDICTED_OBSERVABLE', path)
        alternatives = mechanisms - {primary.get('id')}
        identifiable = bool(alternatives) and all(
            any(primary.get('id') in rows and alternative in rows and
                all(a != b for a, b in zip(rows[primary['id']], rows[alternative]))
                for rows in by_measurement.values())
            for alternative in alternatives)
        if not identifiable:
            fail('NO_DISTINCT_FALSIFIABLE_COMMON_MEASUREMENT_SIGNATURES', path)
        for field in ('discriminatingExperiment', 'decisionCriterion'):
            if not bilingual(case, field):
                fail('MISSING_BILINGUAL_DISCRIMINATOR_OR_DECISION', path + '.' + field)
        if case.get('evidenceStatus') not in CASE_STATUSES:
            fail('MISSING_SCIENTIFIC_CASE_EVIDENCE_STATUS', path)
        if case.get('evidenceStatus') == 'CONTROLLED_SUPPORT' and not bilingual(case, 'controlledSupportJustification'):
            fail('CONTROLLED_SUPPORT_HAS_NO_CONTROL_JUSTIFICATION', path)
    peer = review.get('peerReview')
    if not isinstance(peer, dict):
        fail('MISSING_INDEPENDENT_SCIENTIFIC_PEER_REVIEW', 'academicReview.peerReview')
        peer = {}
    if not text(peer.get('reviewer')) or not text(author) or normalized(peer.get('reviewer', '')) == normalized(author or '') or peer.get('independent') is not True:
        fail('SCIENTIFIC_REVIEWER_NOT_INDEPENDENT', 'academicReview.peerReview')
    if peer.get('status') != 'APPROVED' or not text(peer.get('sourceReference')):
        fail('SCIENTIFIC_PEER_REVIEW_NOT_APPROVED_OR_EVIDENCED', 'academicReview.peerReview')
    try:
        review_at = public.time(peer.get('reviewedAt'))
        if review_at < public.time(snapshot.get('snapshotAt')):
            fail('SCIENTIFIC_REVIEW_PREDATES_SNAPSHOT', 'academicReview.peerReview.reviewedAt')
        if review_at > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
            fail('SCIENTIFIC_REVIEW_DATE_IN_FUTURE', 'academicReview.peerReview.reviewedAt')
    except (ValueError, TypeError):
        fail('INVALID_SCIENTIFIC_PEER_REVIEW_TIME', 'academicReview.peerReview.reviewedAt')
    reviewed_cases = peer.get('reviewedCaseIds')
    if not strings(reviewed_cases) or set(reviewed_cases) != case_ids:
        fail('SCIENTIFIC_PEER_REVIEW_DOES_NOT_COVER_ALL_CASES', 'academicReview.peerReview.reviewedCaseIds')
    checks = peer.get('checks')
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in PEER_CHECKS):
        fail('INCOMPLETE_SCIENTIFIC_PEER_REVIEW_CHECKS', 'academicReview.peerReview.checks')
    concerns = peer.get('concerns')
    if not isinstance(concerns, list):
        fail('MISSING_SCIENTIFIC_REVIEW_CONCERN_RECORD', 'academicReview.peerReview.concerns')
        concerns = []
    for index, concern in enumerate(concerns):
        if concern.get('severity') not in {'BLOCKING', 'ADVISORY'} or not text(concern.get('issue')) or not isinstance(concern.get('resolved'), bool):
            fail('INVALID_SCIENTIFIC_REVIEW_CONCERN', f'academicReview.peerReview.concerns[{index}]')
        elif concern['severity'] == 'BLOCKING' and concern['resolved'] is not True:
            fail('UNRESOLVED_SCIENTIFIC_PEER_REVIEW_BLOCKER', f'academicReview.peerReview.concerns[{index}]')
    return {'passed': not errors, 'gateVersion': 1, 'errors': errors,
            'counts': {'researchQuestions': len(questions), 'theoryModels': len(models),
                       'coreScientificCases': len(cases), 'scientificMainSections': len(main),
                       'appendixSections': len(appendices), 'peerReviewedCases': len(reviewed_cases or [])},
            'scienceCertified': False,
            'limitations': ['Software checks declared scientific structure, evidence references and recorded independent review; it does not certify theoretical validity, source interpretation, prose quality or numerical claims.',
                            'Scientific dominance and falsifiability require the actual independent peer review. No word count is used as proof of academic quality.',
                            'Current molecular graphs and private descriptors do not establish historical lots or causal mechanisms.']}


def validate(document, snapshot, dossier):
    try:
        return _validate(document, snapshot, dossier)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, RecursionError):
        return {'passed': False, 'gateVersion': 1, 'errors': [{'code': 'INVALID_NESTED_ACADEMIC_INPUT_SHAPE', 'path': 'inputs'}],
                'counts': {}, 'scienceCertified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('dossier', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = validate(*(json.loads(path.read_text()) for path in (args.document, args.snapshot, args.dossier)))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    print(json.dumps({'passed': result['passed'], 'errorCodes': dict(Counter(e['code'] for e in result['errors'])),
                      'counts': result['counts'], 'scienceCertified': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
