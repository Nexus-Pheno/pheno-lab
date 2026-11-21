#!/usr/bin/env python3
"""Supplementary source-binding gate for concise research collaborator reports.

Usage: validate_collaborator_report.py DOCUMENT SNAPSHOT DOSSIER
       --previous-snapshot BASELINE [--output PRIVATE_RESULT]

This does not judge chemistry, context adequacy or the truth of a peer-review
attestation. Actual independent review and all existing gates remain mandatory.
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('collaborator_public_gate', BASE / 'validate_rd_document.py')
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)

SOURCE_FIELDS = ('observation', 'problem', 'hypothesis', 'conclusion')
CONTEXT_FIELDS = ('knownPurpose', 'decisionCriticalGap', 'interpretationBoundary', 'questionForLab')
CARD_FIELDS = ('observation', 'proposal', 'mechanism', 'cochangedProperties', 'challenge',
               'experiment', 'decision', 'rankingReason')
PEER_CHECKS = {'contextAdequacy', 'materialIdentityAndConfounds', 'hypothesisDiscrimination',
               'noFabricatedProbabilities', 'conciseMainDecisions', 'structurePrivacy', 'bilingualEquivalence'}
RANKING_BASIS = 'EVIDENCE_FEASIBILITY_DIVERSITY_INFORMATION_GAIN'
NUMERIC_KEY = re.compile(r'(?:probab|likelihood|success.?rate|rank.*score|score|chance)', re.I)
NUMBER = re.compile(r'^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?\s*$')
PROBABILITY_TEXT = re.compile(
    r'(?:\b(?:success\s*(?:probability|rate)|probability\s+of\s+success|chance\s+of\s+success)\b[^.;。；\d]{0,25}\d+(?:\.\d+)?\s*%'
    r'|\d+(?:\.\d+)?\s*%\s*(?:chance|probability|likely\s+to\s+succeed|success\s*(?:probability|rate))\b'
    r'|(?:成功率|成功概率|成功可能性)[^。；\d]{0,15}\d+(?:\.\d+)?\s*[%％]'
    r'|\d+(?:\.\d+)?\s*[%％][^。；]{0,10}(?:成功概率|成功率))', re.I)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def normalized(value):
    return ' '.join(public.decoded(public.html_plain(value)[0]).split()).casefold()


def _validate(document, snapshot, dossier, previous_snapshot):
    original = public.validate(document, snapshot, dossier)
    errors = [{'code': 'PUBLIC_GATE_' + e['code'], 'path': e['path']} for e in original['errors']]

    def fail(code, path):
        errors.append({'code': code, 'path': path})

    review = document.get('collaboratorReview')
    if not isinstance(review, dict) or type(review.get('schemaVersion')) is not int or review.get('schemaVersion') != 1:
        fail('MISSING_COLLABORATOR_REVIEW', 'collaboratorReview')
        review = {}
    if not public.nonempty(review.get('preparedBy')):
        fail('MISSING_COLLABORATOR_AUTHOR', 'collaboratorReview.preparedBy')
    if review.get('rankingBasis') != RANKING_BASIS or review.get('statisticalModelUsed') is not False:
        fail('UNVERIFIED_STATISTICAL_RANKING', 'collaboratorReview.rankingBasis')

    def no_probabilities(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                if NUMERIC_KEY.search(key) and ((isinstance(item, (int, float)) and not isinstance(item, bool))
                                               or (isinstance(item, str) and NUMBER.fullmatch(item))):
                    fail('FABRICATED_NUMERIC_PROBABILITY_OR_RANKING', path + '.' + key)
                no_probabilities(item, path + '.' + key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                no_probabilities(item, path + f'[{index}]')
        elif isinstance(value, str) and PROBABILITY_TEXT.search(normalized(value)):
            fail('FABRICATED_NUMERIC_PROBABILITY_OR_RANKING', path)

    no_probabilities(review, 'collaboratorReview')
    for index, section in enumerate(document.get('sections', [])):
        for lang in ('En', 'Zh'):
            no_probabilities(section.get('body' + lang, ''), f'sections[{index}].body{lang}')

    def aliases(source, path):
        result = set()
        for collection in ('sampleMeasurements', 'historicalSampleMeasurements'):
            rows = source.get(collection)
            if not isinstance(rows, list):
                fail('MISSING_MEASUREMENT_ALIAS_COLLECTION', path + '.' + collection)
                continue
            for row in rows:
                if not isinstance(row, dict) or not public.nonempty(row.get('measurementAlias')):
                    fail('MISSING_STABLE_MEASUREMENT_ALIAS', path + '.' + collection)
                else:
                    result.add(row['measurementAlias'])
        return result

    current_aliases = aliases(snapshot, 'snapshot')
    previous_aliases = aliases(previous_snapshot, 'previousSnapshot')
    count = len(current_aliases - previous_aliases)
    classification = 'NEW_MEASUREMENTS_PRESENT' if count else 'NO_NEW_MEASUREMENTS_CONTEXT_REVISION'
    novelty = review.get('evidenceChange')
    if not isinstance(novelty, dict):
        novelty = {}
    if (type(novelty.get('newMeasurementAliasCount')) is not int
            or novelty.get('newMeasurementAliasCount') != count or novelty.get('classification') != classification):
        fail('EVIDENCE_NOVELTY_DOES_NOT_RECONCILE', 'collaboratorReview.evidenceChange')
    try:
        baseline_at = public.time(previous_snapshot.get('snapshotAt'))
        current_at = public.time(snapshot.get('snapshotAt'))
        if public.time(novelty.get('previousSnapshotAt')) != baseline_at or baseline_at > current_at:
            fail('INVALID_PREVIOUS_SNAPSHOT_BINDING', 'collaboratorReview.evidenceChange.previousSnapshotAt')
    except (ValueError, TypeError):
        fail('INVALID_PREVIOUS_SNAPSHOT_BINDING', 'collaboratorReview.evidenceChange.previousSnapshotAt')
    if previous_snapshot.get('readOnly') is not True or previous_snapshot.get('truncated') is not False:
        fail('UNVERIFIED_PREVIOUS_SNAPSHOT', 'previousSnapshot')

    experiments = {e['code']: e for e in snapshot.get('experimentSummaries', [])}
    known_evidence = public.evidence_ids(snapshot, dossier)
    sections = {s.get('id'): {lang: normalized(s.get('body' + lang, '')) for lang in ('En', 'Zh')}
                for s in document.get('sections', [])}

    def visible(item, fields, path):
        section_id = item.get('sectionId')
        if section_id not in sections:
            fail('COLLABORATOR_ITEM_NOT_LINKED_TO_SECTION', path + '.sectionId')
        for field in fields:
            for lang in ('En', 'Zh'):
                key = field + lang
                value = item.get(key)
                if not public.nonempty(value):
                    fail('MISSING_BILINGUAL_COLLABORATOR_REASONING', path + '.' + key)
                elif not normalized(value) or normalized(value) not in sections.get(section_id, {}).get(lang, ''):
                    fail('COLLABORATOR_REASONING_NOT_VISIBLE', path + '.' + key)

    contexts = review.get('contextReviews')
    if not isinstance(contexts, list) or not contexts:
        fail('MISSING_CONTEXT_REVIEWS', 'collaboratorReview.contextReviews')
        contexts = []
    context_codes = set()
    for index, item in enumerate(contexts):
        path = f'collaboratorReview.contextReviews[{index}]'
        code = item.get('experimentCode')
        if code not in experiments or code in context_codes:
            fail('UNKNOWN_OR_DUPLICATE_CONTEXT_EXPERIMENT', path + '.experimentCode')
        else:
            context_codes.add(code)
        if item.get('contextStatus') not in {'PARTIAL', 'MISSING_PURPOSE', 'SUFFICIENT_FOR_BOUNDED_TEST'}:
            fail('INVALID_CONTEXT_STATUS', path + '.contextStatus')
        if item.get('temporalBasis') != 'CURRENT_NOT_PREREGISTERED':
            fail('CURRENT_CONTEXT_NOT_HISTORICAL_PREREGISTRATION', path + '.temporalBasis')
        hashes = item.get('sourceFieldHashes')
        source = experiments.get(code, {})
        if not isinstance(hashes, dict) or set(hashes) != set(SOURCE_FIELDS):
            fail('INCOMPLETE_CONTEXT_SOURCE_HASHES', path + '.sourceFieldHashes')
            hashes = hashes if isinstance(hashes, dict) else {}
        for field in SOURCE_FIELDS:
            raw = source.get(field)
            if raw is None:
                raw = ''
            if not isinstance(raw, str) or hashes.get(field) != digest(raw):
                fail('CONTEXT_SOURCE_HASH_MISMATCH', path + '.sourceFieldHashes.' + field)
        visible(item, CONTEXT_FIELDS, path)

    cards = review.get('materialCards')
    if not isinstance(cards, list) or not cards:
        fail('MISSING_MATERIAL_PROPOSAL_CARDS', 'collaboratorReview.materialCards')
        cards = []
    card_ids, source_codes = set(), set()
    for index, item in enumerate(cards):
        path = f'collaboratorReview.materialCards[{index}]'
        identifier = item.get('id')
        if not public.nonempty(identifier) or not public.IDENTIFIER.fullmatch(identifier) or identifier in card_ids:
            fail('INVALID_OR_DUPLICATE_MATERIAL_CARD_ID', path + '.id')
        else:
            card_ids.add(identifier)
        codes = item.get('sourceExperimentCodes')
        if not public.unique_strings(codes) or not set(codes).issubset(experiments):
            fail('UNKNOWN_OR_MISSING_MATERIAL_SOURCE_EXPERIMENTS', path + '.sourceExperimentCodes')
        else:
            source_codes.update(codes)
        evidence = item.get('evidenceIds')
        if not public.unique_strings(evidence) or not set(evidence).issubset(known_evidence):
            fail('UNKNOWN_OR_MISSING_MATERIAL_EVIDENCE', path + '.evidenceIds')
        if item.get('status') != 'PROPOSED_NOT_EXECUTED' or item.get('priority') not in {'P0', 'P1', 'P2'}:
            fail('MATERIAL_CARD_NOT_EXPLICIT_PRIORITIZED_PROPOSAL', path)
        if item.get('candidateBasis') not in {'CURRENT_VERIFIED_REGISTRY', 'NAME_IDENTITY_PENDING', 'PRIVATE_DRAFT_CHEMIST_REVIEW_PENDING'}:
            fail('INVALID_CANDIDATE_IDENTITY_BASIS', path + '.candidateBasis')
        if ((item.get('executed') is not None and item.get('executed') is not False)
                or (item.get('synthesisApproved') is not None and item.get('synthesisApproved') is not False)):
            fail('MATERIAL_PROPOSAL_CANNOT_IMPLY_EXECUTION_APPROVAL', path)
        if item.get('candidateBasis') == 'PRIVATE_DRAFT_CHEMIST_REVIEW_PENDING' and (
                item.get('chemistReview') != 'PENDING' or item.get('synthesisApproved') is not False or item.get('executed') is not False):
            fail('PRIVATE_DRAFT_REQUIRES_PENDING_CHEMIST_REVIEW', path)
        visible(item, CARD_FIELDS, path)
    selected_codes = {e['experimentCode'] for e in (document.get('decisionReview') or {}).get('selectedExperiments', [])}
    if (source_codes | selected_codes) - context_codes:
        fail('INCOMPLETE_RESEARCH_CONTEXT_COVERAGE', 'collaboratorReview.contextReviews')

    peer = review.get('peerReview')
    if not isinstance(peer, dict):
        peer = {}
    if (not public.nonempty(peer.get('reviewer')) or normalized(peer.get('reviewer', '')) == normalized(review.get('preparedBy', ''))
            or peer.get('independent') is not True or peer.get('status') != 'APPROVED'
            or not public.nonempty(peer.get('sourceReference'))):
        fail('MISSING_APPROVED_INDEPENDENT_COLLABORATOR_REVIEW', 'collaboratorReview.peerReview')
    if not isinstance(peer.get('checks'), dict) or any(peer['checks'].get(key) is not True for key in PEER_CHECKS):
        fail('INCOMPLETE_COLLABORATOR_PEER_CHECKS', 'collaboratorReview.peerReview.checks')
    for key, expected in [('reviewedCardIds', card_ids), ('reviewedExperimentCodes', context_codes | source_codes)]:
        if not public.unique_strings(peer.get(key), allow_empty=not expected) or set(peer.get(key, [])) != expected:
            fail('INCOMPLETE_COLLABORATOR_PEER_COVERAGE', 'collaboratorReview.peerReview.' + key)
    try:
        reviewed_at = public.time(peer.get('reviewedAt'))
        if reviewed_at < public.time(snapshot.get('snapshotAt')) or reviewed_at > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
            fail('COLLABORATOR_PEER_REVIEW_NOT_CURRENT', 'collaboratorReview.peerReview.reviewedAt')
    except (ValueError, TypeError):
        fail('INVALID_COLLABORATOR_PEER_TIME', 'collaboratorReview.peerReview.reviewedAt')
    return {'passed': not errors, 'gateVersion': 1, 'errors': errors, 'scienceCertified': False,
            'counts': {'newMeasurementAliases': count, 'contextReviews': len(contexts), 'materialCards': len(cards)},
            'limitations': ['Checks source binding, visible bilingual reasoning, proposal status and declared independent review; it does not certify chemistry or context adequacy.',
                            'Actual independent scientific review and the decision, academic, private-mechanism and public/privacy gates remain mandatory.']}


def validate(document, snapshot, dossier, previous_snapshot):
    try:
        if not all(isinstance(value, dict) for value in (document, snapshot, dossier, previous_snapshot)):
            raise TypeError('Invalid input object')
        return _validate(document, snapshot, dossier, previous_snapshot)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, RecursionError):
        return {'passed': False, 'gateVersion': 1, 'scienceCertified': False,
                'errors': [{'code': 'INVALID_NESTED_COLLABORATOR_INPUT_SHAPE', 'path': 'inputs'}], 'counts': {}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('document', 'snapshot', 'dossier'):
        parser.add_argument(name, type=Path)
    parser.add_argument('--previous-snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    inputs = [json.loads(path.read_text()) for path in (args.document, args.snapshot, args.dossier, args.previous_snapshot)]
    result = validate(*inputs)
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
