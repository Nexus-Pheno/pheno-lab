#!/usr/bin/env python3
"""Bind a bilingual result-first report to its actual clarity/scope review.

Usage: validate_language_review.py DOCUMENT [--output PRIVATE_RESULT]

This gate checks declared visible passages, order, method centralization and
review coverage. It cannot determine whether a technical judgment is true or a
limitation is important. Existing scientific/privacy gates and real independent
reading remain mandatory. No uncertainty-word blacklist or text rewriting occurs.
"""
import argparse
from collections import Counter
import datetime as dt
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys

STANDARD = 'RESULT_JUDGMENT_ISSUE_NEXT_V1'
CHECKS = {'resultsLead', 'targetedLimitations', 'commonMethodsCentralized',
          'concreteQuestions', 'evidenceScopePreserved', 'bilingualEquivalence'}
RESULT_STATUSES = {'OBSERVED', 'NO_ELIGIBLE_OUTCOME', 'PLANNED_NOT_MEASURED'}
BLOCK_TAGS = {'p', 'li', 'blockquote'}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def normalized(value):
    return ' '.join(html.unescape(str(value)).split()).casefold()


class VisibleBlocks(HTMLParser):
    """Read body text, excluding comments, attributes and explicitly hidden text.

    Native details remain readable on expansion. They are allowed for common
    methods/appendices. The scientific/public gate independently forbids scripts,
    unsafe resources and private structures; this parser grants no HTML safety.
    """
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.blocks = []
        self.active = []
        self.all_text = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        hidden = (tag in {'script', 'style', 'template', 'noscript'}
                  or 'hidden' in attrs or attrs.get('aria-hidden', '').lower() == 'true'
                  or bool(re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)',
                                    attrs.get('style', ''), re.I)))
        hidden = hidden or any(item[1] for item in self.stack)
        self.stack.append((tag, hidden))
        if tag in BLOCK_TAGS and not hidden:
            self.active.append([tag, []])
        if tag == 'br' and not hidden:
            self.handle_data(' ')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in BLOCK_TAGS and self.active and self.active[-1][0] == tag:
            _, parts = self.active.pop()
            value = normalized(''.join(parts))
            if value:
                self.blocks.append(value)
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break
        if not any(item[1] for item in self.stack):
            self.all_text.append(' ')

    def handle_data(self, value):
        if not any(item[1] for item in self.stack):
            self.all_text.append(value)
            for _, parts in self.active:
                parts.append(value)


def visible(value):
    parser = VisibleBlocks()
    parser.feed(value)
    parser.close()
    return normalized(''.join(parser.all_text)), parser.blocks


def _validate(document):
    errors = []
    def fail(code, path):
        errors.append({'code': code, 'path': path})
    review = document.get('languageReview')
    if not isinstance(review, dict) or type(review.get('schemaVersion')) is not int or review.get('schemaVersion') != 1:
        return {'passed': False, 'gateVersion': 1, 'standardVersion': STANDARD,
                'errors': [{'code': 'MISSING_LANGUAGE_REVIEW', 'path': 'languageReview'}],
                'counts': {}, 'scienceCertified': False, 'languageQualityCertified': False}
    if review.get('standardVersion') != STANDARD:
        fail('UNKNOWN_LANGUAGE_STANDARD', 'languageReview.standardVersion')
    author = review.get('preparedBy')
    if not text(author):
        fail('MISSING_LANGUAGE_AUTHOR', 'languageReview.preparedBy')
    sections = {s['id']: s for s in document.get('sections', [])
                if isinstance(s, dict) and text(s.get('id'))}
    parsed = {(key, lang): visible(value.get('body' + lang, ''))
              for key, value in sections.items() for lang in ('En', 'Zh')}
    methods_id = review.get('sharedMethodsSectionId')
    if methods_id not in sections:
        fail('MISSING_SHARED_METHODS_SECTION', 'languageReview.sharedMethodsSectionId')
    statements = review.get('commonStatements')
    if not isinstance(statements, list) or not statements:
        fail('MISSING_CENTRALIZED_COMMON_STATEMENTS', 'languageReview.commonStatements')
        statements = []
    common_ids = set()
    for index, statement in enumerate(statements):
        path = f'languageReview.commonStatements[{index}]'
        if not isinstance(statement, dict):
            fail('INVALID_COMMON_STATEMENT', path)
            continue
        identifier = statement.get('id')
        if not text(identifier) or identifier in common_ids:
            fail('DUPLICATE_OR_MISSING_COMMON_STATEMENT_ID', path)
        common_ids.add(identifier)
        for lang in ('En', 'Zh'):
            value = statement.get('text' + lang)
            if not text(value):
                fail('MISSING_BILINGUAL_COMMON_STATEMENT', path + '.text' + lang)
                continue
            target = normalized(value)
            count = sum(body.count(target) for (key, language), (body, _) in parsed.items() if language == lang)
            if target not in parsed.get((methods_id, lang), ('', []))[0]:
                fail('COMMON_STATEMENT_NOT_IN_SHARED_METHODS', path + '.text' + lang)
            if count != 1:
                fail('COMMON_STATEMENT_NOT_CENTRALIZED_ONCE', path + '.text' + lang)
    cases = review.get('experiments')
    if not isinstance(cases, list):
        fail('MISSING_RESULT_FIRST_EXPERIMENTS', 'languageReview.experiments')
        cases = []
    found = set()
    for index, case in enumerate(cases):
        path = f'languageReview.experiments[{index}]'
        if not isinstance(case, dict):
            fail('INVALID_RESULT_FIRST_EXPERIMENT', path)
            continue
        code = case.get('experimentCode')
        if not text(code) or code in found:
            fail('DUPLICATE_OR_MISSING_LANGUAGE_EXPERIMENT', path)
        found.add(code)
        section_id = case.get('sectionId')
        if section_id not in sections or section_id == methods_id:
            fail('MISSING_OR_SHARED_EXPERIMENT_SECTION', path + '.sectionId')
        if case.get('resultEvidenceStatus') not in RESULT_STATUSES:
            fail('RESULT_EVIDENCE_STATUS_NOT_EXPLICIT', path + '.resultEvidenceStatus')
        if case.get('nextStepStatus') != 'PROPOSED_NOT_EXECUTED':
            fail('NEXT_STEP_MUST_REMAIN_REPORT_PROPOSAL', path + '.nextStepStatus')
        issue_status = case.get('keyIssueStatus')
        if issue_status not in {'SPECIFIC', 'NONE_DECISION_CRITICAL'}:
            fail('INVALID_KEY_ISSUE_STATUS', path + '.keyIssueStatus')
        fields = ['result', 'judgment'] + (['keyIssue'] if issue_status == 'SPECIFIC' else []) + ['nextStep']
        if issue_status == 'NONE_DECISION_CRITICAL' and any(text(case.get('keyIssue' + lang)) for lang in ('En', 'Zh')):
            fail('UNNECESSARY_GENERIC_KEY_ISSUE', path + '.keyIssueStatus')
        for lang in ('En', 'Zh'):
            body, blocks = parsed.get((section_id, lang), ('', []))
            places = []
            block_places = []
            for field in fields:
                value = case.get(field + lang)
                if not text(value):
                    fail('MISSING_BILINGUAL_RESULT_FIRST_PASSAGE', path + '.' + field + lang)
                    continue
                target = normalized(value)
                position = body.find(target)
                block = next((i for i, b in enumerate(blocks) if target in b), -1)
                if position == -1 or block == -1:
                    fail('RESULT_FIRST_PASSAGE_NOT_VISIBLE', path + '.' + field + lang)
                places.append(position)
                block_places.append(block)
            if len(places) == len(fields) and any(a < 0 or a >= b for a, b in zip(places, places[1:])):
                fail('EXPERIMENT_NOT_RESULT_JUDGMENT_ISSUE_NEXT_ORDER', path + '.' + lang)
            if len(block_places) == len(fields):
                # Result and judgment may be two clear sentences in one paragraph.
                # The decision-critical issue and next action get their own blocks.
                if issue_status == 'SPECIFIC' and block_places[2] <= block_places[1]:
                    fail('RESULT_JUDGMENT_AND_LIMITATION_COLLAPSED', path + '.' + lang)
                if block_places[-1] <= block_places[-2]:
                    fail('NEXT_STEP_NOT_SEPARATE_FROM_KEY_ISSUE', path + '.' + lang)
    expected = {x.get('experimentCode') for x in (document.get('evidenceMethodReview') or {}).get('experiments', [])
                if isinstance(x, dict) and text(x.get('experimentCode'))}
    if expected and found != expected:
        fail('RESULT_FIRST_PRIMARY_CASE_COVERAGE_MISMATCH', 'languageReview.experiments')
    peer = review.get('peerReview')
    if not isinstance(peer, dict):
        peer = {}
    if (not text(peer.get('reviewer')) or peer.get('reviewer') == author
            or peer.get('independent') is not True or peer.get('status') != 'APPROVED'
            or not text(peer.get('sourceReference'))):
        fail('MISSING_ACTUAL_INDEPENDENT_LANGUAGE_SCOPE_REVIEW', 'languageReview.peerReview')
    try:
        when = dt.datetime.fromisoformat(peer.get('reviewedAt', '').replace('Z', '+00:00'))
        if when.utcoffset() is None:
            raise ValueError('timezone')
        if when > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
            fail('LANGUAGE_REVIEW_DATE_IN_FUTURE', 'languageReview.peerReview.reviewedAt')
    except (ValueError, TypeError):
        fail('INVALID_LANGUAGE_REVIEW_TIME', 'languageReview.peerReview.reviewedAt')
    coverage = peer.get('reviewedExperimentCodes')
    if not isinstance(coverage, list) or set(coverage) != found or len(coverage) != len(set(coverage)):
        fail('INCOMPLETE_LANGUAGE_REVIEW_COVERAGE', 'languageReview.peerReview.reviewedExperimentCodes')
    checks = peer.get('checks') or {}
    if any(checks.get(key) is not True for key in CHECKS):
        fail('MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK', 'languageReview.peerReview.checks')
    concerns = peer.get('concerns')
    if not isinstance(concerns, list):
        fail('MISSING_LANGUAGE_SCOPE_REVIEW_CONCERNS', 'languageReview.peerReview.concerns')
    else:
        for index, concern in enumerate(concerns):
            if not isinstance(concern, dict) or concern.get('severity') not in {'BLOCKING', 'ADVISORY'} or not text(concern.get('issue')) or type(concern.get('resolved')) is not bool:
                fail('INVALID_LANGUAGE_SCOPE_REVIEW_CONCERN', f'languageReview.peerReview.concerns[{index}]')
            elif concern['severity'] == 'BLOCKING' and concern['resolved'] is not True:
                fail('UNRESOLVED_LANGUAGE_OR_SCOPE_CONCERN', f'languageReview.peerReview.concerns[{index}]')
    return {'passed': not errors, 'gateVersion': 1, 'standardVersion': STANDARD,
            'errors': errors, 'counts': {'experiments': len(found), 'centralizedStatements': len(statements)},
            'scienceCertified': False, 'languageQualityCertified': False,
            'limitations': ['This validates visible structure and recorded review, not the truth or readability of the reasoning.',
                            'A real independent reader must check clarity, specific limitations and preservation of scientific scope.',
                            'No uncertainty-word ban or automatic qualifier deletion is applied.']}


def validate(document):
    try:
        if not isinstance(document, dict):
            raise TypeError('document')
        return _validate(document)
    except (TypeError, ValueError, KeyError, AttributeError, IndexError):
        return {'passed': False, 'gateVersion': 1, 'standardVersion': STANDARD,
                'errors': [{'code': 'INVALID_LANGUAGE_REVIEW_SHAPE', 'path': 'languageReview'}],
                'counts': {}, 'scienceCertified': False, 'languageQualityCertified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = validate(json.loads(args.document.read_text()))
    if args.output:
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    print(json.dumps({'passed': result['passed'], 'errorCodes': dict(Counter(e['code'] for e in result['errors'])),
                      'counts': result['counts'], 'scienceCertified': False, 'languageQualityCertified': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
