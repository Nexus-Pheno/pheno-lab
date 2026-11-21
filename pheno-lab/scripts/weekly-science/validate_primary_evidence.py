#!/usr/bin/env python3
"""Bind the 28 October report method to shared app evidence and readable decisions.

This supplements, and never replaces, raw-source, numerical, scientific and
privacy review. It does not recompute or certify the app's scientific methods.
"""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
from html import unescape

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('shared_app_evidence', BASE / 'shared_app_evidence.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def normalized(value):
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]*>', ' ', str(value)))).strip().casefold()


def same_number(first, second):
    if first is None or second is None:
        return first is second
    return (isinstance(first, (float, int)) and not isinstance(first, bool)
            and isinstance(second, (float, int)) and not isinstance(second, bool)
            and math.isfinite(first) and math.isfinite(second)
            and math.isclose(first, second, rel_tol=1e-10, abs_tol=1e-10))


def validate(document, snapshot, dossier):
    errors = []
    def fail(code, path):
        errors.append({'code': code, 'path': path})
    export = snapshot.get('sharedAppEvidence')
    review = document.get('evidenceMethodReview')
    if export is None:
        if review is not None:
            fail('NEW_METHOD_HAS_NO_SHARED_APP_EVIDENCE', 'evidenceMethodReview')
        return {'passed': not errors, 'errors': errors, 'methodApplied': False, 'scienceCertified': False}
    try:
        shared.validate_export(export, snapshot)
    except (ValueError, TypeError, KeyError):
        fail('INVALID_SHARED_APP_EVIDENCE', 'snapshot.sharedAppEvidence')
        return {'passed': False, 'errors': errors, 'methodApplied': True, 'scienceCertified': False}
    primary = dossier.get('primaryExperimentEvidence')
    expected = shared.dossier_primary_evidence(snapshot)
    if primary != expected:
        fail('DOSSIER_PRIMARY_EVIDENCE_NOT_EXACT_EXPORTED_FACTS', 'dossier.primaryExperimentEvidence')
    if not isinstance(review, dict) or review.get('schemaVersion') != 1 or review.get('methodVersion') != shared.METHOD_VERSION:
        fail('MISSING_SHARED_EVIDENCE_METHOD_REVIEW', 'evidenceMethodReview')
        return {'passed': False, 'errors': errors, 'methodApplied': True, 'scienceCertified': False}
    if (review.get('selectionScope') != shared.SELECTION_SCOPE
            or review.get('primaryEvidenceAsOf') != export['asOf']
            or review.get('legacyPeriodPanelsRole') != 'SECONDARY_SCAN_MEDIAN_ROBUSTNESS_AND_PERIOD_TRACE'
            or review.get('conditionDisclosurePolicy') != 'NAMED_MATERIAL_DOSE_CARRIER_PROCESS_ONLY'
            or review.get('privacyProjectionReviewed') is not True):
        fail('PRIMARY_POPULATION_OR_DISCLOSURE_POLICY_NOT_EXPLICIT', 'evidenceMethodReview')
    sections = {s.get('id'): s for s in document.get('sections', []) if isinstance(s, dict)}
    sources = {item['experimentCode']: item for item in export['experiments']}
    bindings = review.get('experiments')
    if not isinstance(bindings, list) or (sources and not bindings):
        fail('MISSING_PRIMARY_EXPERIMENT_JUDGMENTS', 'evidenceMethodReview.experiments')
        bindings = []
    found = set()
    comparison_count = 0
    for index, item in enumerate(bindings):
        path = f'evidenceMethodReview.experiments[{index}]'
        if not isinstance(item, dict) or item.get('experimentCode') in found or item.get('experimentCode') not in sources:
            fail('UNKNOWN_OR_REPEATED_PRIMARY_EXPERIMENT', path)
            continue
        code = item['experimentCode']
        found.add(code)
        source = sources[code]
        evidence = source['evidence']
        if item.get('sourceHash') != evidence['sourceHash'] or item.get('policyVersion') != evidence['policyVersion']:
            fail('PRIMARY_EXPERIMENT_SOURCE_HASH_OR_POLICY_MISMATCH', path)
        section = sections.get(item.get('sectionId'))
        if section is None:
            fail('PRIMARY_JUDGMENT_HAS_NO_REPORT_SECTION', path)
            section = {}
        # One canonical short passage per element is sufficient; do not repeat
        # controls/causes/branches just to satisfy several acceptance envelopes.
        selection_section_id = item.get('selectionSectionId', item.get('sectionId'))
        selection_section = sections.get(selection_section_id)
        if 'selectionSectionId' in item and selection_section is None:
            fail('PRIMARY_SELECTION_DEFINITION_HAS_NO_SHARED_SECTION', path + '.selectionSectionId')
        language_review = document.get('languageReview')
        if 'selectionSectionId' in item:
            if (not isinstance(language_review, dict) or language_review.get('schemaVersion') != 1
                    or language_review.get('standardVersion') != 'RESULT_JUDGMENT_ISSUE_NEXT_V1'):
                fail('PRIMARY_SHARED_SELECTION_REQUIRES_LANGUAGE_REVIEW', path + '.selectionSectionId')
            elif selection_section_id != language_review.get('sharedMethodsSectionId'):
                fail('PRIMARY_SELECTION_SECTION_DIFFERS_FROM_SHARED_METHODS', path + '.selectionSectionId')
        for field in ('conditionSummary', 'selectionDefinition', 'judgment', 'mainIssue', 'nextTest'):
            for lang in ('En', 'Zh'):
                text = item.get(field + lang)
                target_section = (selection_section or {}) if field == 'selectionDefinition' else section
                if not isinstance(text, str) or not text.strip() or normalized(text) not in normalized(target_section.get('body' + lang, '')):
                    fail('PRIMARY_FACT_OR_DECISION_NOT_READABLE_IN_BOTH_LANGUAGES', path + '.' + field + lang)
        if item.get('referenceGroup') != evidence.get('reference', {}).get('selectedGroup'):
            fail('PRIMARY_COMPARATOR_DIFFERS_FROM_EXPORTED_SELECTION', path + '.referenceGroup')
        comparisons = item.get('comparisons')
        if not isinstance(comparisons, list):
            fail('PRIMARY_COMPARISON_FACTS_NOT_DECLARED', path + '.comparisons')
            comparisons = []
        if not comparisons and any(
                group.get('metrics', {}).get('pce') is not None
                for characterization in evidence['characterizations']
                for group in characterization.get('groups', [])):
            fail('MEASURED_PRIMARY_JUDGMENT_HAS_NO_BOUND_COMPARISON', path + '.comparisons')
        seen = set()
        characterizations = {c['id']: c for c in evidence['characterizations']}
        for j, comparison in enumerate(comparisons):
            cp = path + f'.comparisons[{j}]'
            key = (comparison.get('characterizationId'), comparison.get('group'))
            characterization = characterizations.get(key[0])
            group = next((g for g in (characterization or {}).get('groups', []) if g['label'] == key[1]), None)
            if key in seen or group is None:
                fail('UNKNOWN_OR_REPEATED_PRIMARY_GROUP_COMPARISON', cp)
                continue
            seen.add(key)
            comparison_count += 1
            pce = group.get('metrics', {}).get('pce')
            expected_values = {'nDevices': pce.get('n') if pce else 0,
                               'meanPce': pce.get('mean') if pce else None,
                               'bestPce': pce.get('best') if pce else None,
                               'sdPce': pce.get('sd') if pce else None,
                               'deltaMeanPce': group.get('deltaMean', {}).get('pce'),
                               'deltaBestPce': group.get('deltaBest', {}).get('pce')}
            if any(not same_number(comparison.get(key), value) for key, value in expected_values.items()):
                fail('PRIMARY_NUMBERS_DIFFER_FROM_SHARED_DEVICE_FACTS', cp)
            if (comparison.get('potential') != group.get('judgment')
                    or comparison.get('evidenceConfidence') != group.get('evidenceConfidence')):
                fail('PRIMARY_POTENTIAL_AND_CONFIDENCE_CONFLATED_OR_CHANGED', cp)
        if item.get('aiInterpretationUsed') is True:
            ai = source.get('aiInterpretation') or {}
            summary = ai.get('summary') or {}
            if (ai.get('sourceHashMatches') is not True or ai.get('selectionMatchesPrimaryEvidence') is not True
                    or ai.get('versionCurrent') is not True
                    or ai.get('reviewState') != 'reviewed' or item.get('aiSourceHash') != summary.get('sourceHash')):
                fail('UNREVIEWED_STALE_OR_DIFFERENT_POPULATION_AI_USED', path)
        elif item.get('aiInterpretationUsed') is not False:
            fail('AI_INTERPRETATION_USE_NOT_EXPLICIT', path)
    omitted = review.get('omittedExperimentCount')
    if not isinstance(omitted, int) or isinstance(omitted, bool) or omitted != len(sources) - len(found):
        fail('PRIMARY_REVIEW_SCOPE_NOT_COMPLETE', 'evidenceMethodReview.omittedExperimentCount')
    return {'passed': not errors, 'errors': errors, 'methodApplied': True,
            'counts': {'primaryExperiments': len(found), 'primaryComparisons': comparison_count},
            'scienceCertified': False,
            'limitations': ['Checks exact app-source binding and concise visible decisions, not scientific correctness.',
                            'The 0.5-point rule is an exploratory internal reference, not a confirmation or rejection threshold.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('dossier', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = validate(*(json.loads(p.read_text()) for p in (args.document, args.snapshot, args.dossier)))
    except (ValueError, TypeError, KeyError, AttributeError):
        result = {'passed': False, 'errors': [{'code': 'INVALID_PRIMARY_METHOD_INPUT', 'path': 'inputs'}], 'scienceCertified': False}
    if args.output:
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    print(json.dumps({'passed': result['passed'], 'errorCodes': sorted({e['code'] for e in result['errors']}), 'scienceCertified': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
