#!/usr/bin/env python3
"""Fail-closed R&D report contract/privacy gate; it does not certify the science.

Usage: validate_rd_document.py DOCUMENT SNAPSHOT DOSSIER [--output PRIVATE_RESULT]
All inputs stay local/private. The rdReview envelope is not rendered into HTML.
"""
import argparse
from collections import Counter
import datetime as dt
import html
from html.parser import HTMLParser
import ipaddress
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import unquote, urlsplit

_primary_spec = importlib.util.spec_from_file_location('primary_evidence_gate', Path(__file__).with_name('validate_primary_evidence.py'))
primary_gate = importlib.util.module_from_spec(_primary_spec)
_primary_spec.loader.exec_module(primary_gate)
_language_spec = importlib.util.spec_from_file_location('report_language_gate', Path(__file__).with_name('validate_language_review.py'))
language_gate = importlib.util.module_from_spec(_language_spec)
_language_spec.loader.exec_module(language_gate)

ROLES = {'projects', 'performance', 'reproducibility', 'continuity', 'mechanisms',
         'priorities', 'limitations', 'literature'}
MARKS = {'bilingual', 'numericalClaims', 'evidenceLineage', 'privacy', 'proposalStatus'}
IDENTIFIER = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}\Z')
SECTION_ID = re.compile(r'[a-z][a-z0-9-]{0,63}\Z')
STRUCTURE_ATTRIBUTE = re.compile(r'(?:\brdkit\b|\b(?:bond|atom)[-_]?\d+\b|molecular[-_ ]?(?:structure|graph|descriptor)|chemical[-_ ]?structure|smiles)', re.I)
STRUCTURE_URL = re.compile(r'(?:/api/chemicals(?:/|$)|/chemicals(?:/|$)|smiles|(?:^|[/_.-])(?:rdkit|molecule|molecular[-_]?structure|chemical[-_]?structure|molfile)(?:[/_.?=-]|$)|\.mol(?:\?|$)|\.sdf(?:\?|$))', re.I)
DESCRIPTOR_KEYS = re.compile(r'\b(?:MolLogP|MolMR|TPSA|NumHDonors|NumHAcceptors|MorganFingerprint|rdkitDescriptors|privateChemistryDefinitions|canonicalSmiles|inputSha256|structureSha256)\b')
DISALLOWED_TAGS = {'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
                   'form', 'input', 'button', 'audio', 'video', 'foreignobject', 'image', 'img'}


def decoded(value):
    """Bounded repeated decoding catches entities, escaped percent URLs and full width."""
    value = unicodedata.normalize('NFKC', str(value))
    for _ in range(4):
        new = html.unescape(unquote(value))
        if new == value:
            break
        value = new
    return value


def project_alias(value):
    return 'UNASSIGNED' if value is None else value


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def unique_strings(values, allow_empty=False):
    return (isinstance(values, list) and (allow_empty or bool(values))
            and all(nonempty(v) for v in values) and len(values) == len(set(values)))


def time(value):
    if not isinstance(value, str):
        raise ValueError('Missing timestamp')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.utcoffset() is None:
        raise ValueError('Timestamp requires offset')
    return parsed


def public_https(value):
    if not nonempty(value):
        return False
    try:
        parsed = urlsplit(decoded(value))
        hostname = (parsed.hostname or '').lower().rstrip('.')
        if (parsed.scheme != 'https' or not hostname or '.' not in hostname or parsed.username or parsed.password
                or parsed.port not in (None, 443) or any(c.isspace() for c in value)
                or hostname in {'localhost', 'lab.szkl.com'}
                or hostname.endswith(('.localhost', '.local', '.internal', '.test', '.invalid', '.lan'))):
            return False
        try:
            ipaddress.ip_address(hostname)
            return False
        except ValueError:
            pass
        return not STRUCTURE_URL.search(parsed.path + '?' + parsed.query + '#' + parsed.fragment)
    except (ValueError, UnicodeError):
        return False


class PublicationBody(HTMLParser):
    """Scientific chart SVGs are allowed; body image payloads fail closed.

    Raster images cannot be mechanically distinguished from molecular diagrams.
    The renderer's separately approved brand asset is outside document bodies.
    """
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text = []
        self.hrefs = set()
        self.violations = set()
        self.svg_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in DISALLOWED_TAGS:
            self.violations.add('DISALLOWED_BODY_ELEMENT')
        if tag == 'svg':
            self.svg_depth += 1
        for key, value in attrs:
            value = decoded(value or '')
            if key.startswith('on') or key in {'srcdoc', 'action', 'formaction'}:
                self.violations.add('EXECUTABLE_BODY_ATTRIBUTE')
            if STRUCTURE_ATTRIBUTE.search(key + ' ' + value):
                self.violations.add('STRUCTURE_DIAGRAM_OR_ATTRIBUTE')
            if key == 'style' and re.search(r'url\s*\(|@import|expression\s*\(', value, re.I):
                self.violations.add('EXTERNAL_OR_EXECUTABLE_STYLE')
            if key in {'href', 'src', 'xlink:href'}:
                if STRUCTURE_URL.search(value):
                    self.violations.add('STRUCTURE_URL')
                if tag == 'a' and key == 'href' and value.startswith('https://'):
                    self.hrefs.add(value)
                elif not value.startswith('#'):
                    self.violations.add('DISALLOWED_BODY_RESOURCE')
        if tag == 'a' and not any(k == 'href' for k, _ in attrs):
            self.violations.add('REFERENCE_WITHOUT_TARGET')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag == 'svg':
            self.svg_depth -= 1

    def handle_endtag(self, tag):
        if tag == 'svg':
            self.svg_depth = max(0, self.svg_depth - 1)

    def handle_data(self, data):
        self.text.append(data)
        if self.svg_depth and STRUCTURE_ATTRIBUTE.search(data):
            self.violations.add('STRUCTURE_DIAGRAM_TEXT')

    def handle_comment(self, data):
        if STRUCTURE_ATTRIBUTE.search(data):
            self.violations.add('STRUCTURE_DIAGRAM_COMMENT')


def html_plain(value):
    parser = PublicationBody()
    parser.feed(decoded(value))
    parser.close()
    return ''.join(parser.text), parser


def molecular_context_values(value):
    """Explicit notation fields/code are distinct from ordinary group letters.

    A legacy substrate card can contain an unreviewed atomic letter. That alone
    cannot distinguish a molecular disclosure from a group label or prose.
    Restrict this one narrow ambiguous case to explicit notation contexts;
    trusted chemistry evidence and all longer notation still use full coverage.
    """
    value = decoded(value)
    plain, _ = html_plain(value)
    contexts = []
    for content in re.findall(r'<(?:code|pre)\b[^>]*>(.*?)</(?:code|pre)\s*>', value, re.I | re.S):
        contexts.append(html_plain(content)[0])
    labels = r'(?:SMILES|(?:molecular|chemical)\s+(?:formula|notation|structure)|分子式|化学式|结构式|分子结构|化学结构)'
    # The value must immediately follow the label/assignment, not a later group
    # mention in a paragraph explaining that molecular notation is omitted.
    following = re.compile(labels + r'\s*(?:(?:[:：=]|\bis\b|为|是)\s*)?[\"\'`(\[]*\s*([^\s<>]{1,80})', re.I)
    for match in following.finditer(plain):
        contexts.append(match.group(1))
    return contexts


def private_leak(public_values, snapshot):
    """Return counts only; never print the matching private notation."""
    needles = set()
    context_only = set()
    for definition in snapshot.get('privateChemistryDefinitions', []):
        for value in (definition.get('smiles'), (definition.get('chemistry') or {}).get('canonicalSmiles')):
            if nonempty(value):
                needle = re.sub(r'\s+', '', decoded(value))
                legacy_substrate_letter = (len(needle) == 1
                    and str(definition.get('category', '')).upper() in {'SUBSTRATE', 'SUBSTRATE_MAT'}
                    and not definition.get('chemistry')
                    and definition.get('validatedDefinition') is not True
                    and definition.get('inSamRegistry') is not True
                    and (definition.get('hashValidation') or {}).get('status') in {None, 'NO_EVIDENCE'})
                (context_only if legacy_substrate_letter else needles).add(needle)
    # The same notation anywhere in trusted evidence must remain strict, even
    # when another unrelated legacy card also uses the same one-character value.
    context_only -= needles
    views = []
    for value in public_values:
        text = decoded(value)
        plain, _ = html_plain(text)
        views.extend((text, plain))
    long_hits = short_hits = 0
    for needle in needles:
        if len(needle) >= 8:
            if any(needle in re.sub(r'\s+', '', value) for value in views):
                long_hits += 1
        else:
            # Exact, case-sensitive bounded notation tokens avoid matching CCO
            # inside longer ordinary words. Optional whitespace catches split
            # short notation without collapsing the surrounding prose.
            expression = r'(?<![A-Za-z0-9])' + r'\s*'.join(map(re.escape, needle)) + r'(?![A-Za-z0-9])'
            if any(re.search(expression, value) for value in views):
                short_hits += 1
    explicit_contexts = [context for value in public_values for context in molecular_context_values(value)]
    for needle in context_only:
        expression = r'(?<![A-Za-z0-9])' + re.escape(needle) + r'(?![A-Za-z0-9])'
        if any(re.search(expression, value) for value in explicit_contexts):
            short_hits += 1
    return {'definitionsChecked': len(needles | context_only), 'longNotationMatches': long_hits,
            'shortNotationMatches': short_hits, 'ambiguousLegacySubstrateLettersContextChecked': len(context_only)}


def material_coverage(snapshot):
    """Only explicit SAM/Additive categories; names never infer chemistry identity."""
    used, known = {}, set()
    for experiment in snapshot.get('experimentSummaries', []):
        for step in experiment.get('steps', []):
            selections = list(step.get('materials', []))
            for execution in step.get('executions', []):
                selections += execution.get('materialSelections', [])
            for selection in selections:
                material = selection.get('material') or {}
                alias = material.get('materialAlias') or material.get('id')
                if not nonempty(alias):
                    continue
                known.add(alias)
                category = re.sub(r'[\s_-]+', '', str(material.get('category', '')).upper())
                if category in {'SAM', 'ADDITIVE', 'ADDITIVES'}:
                    used[alias] = material
    definitions = {d.get('materialAlias') or d.get('id'): d for d in snapshot.get('privateChemistryDefinitions', [])}
    known.update(alias for alias in definitions if nonempty(alias))
    missing = {}
    for alias in used:
        definition = definitions.get(alias)
        if snapshot.get('chemistryAccessAvailable') is not True:
            missing[alias] = 'NO_CHEMISTRY_ACCESS'
        elif not definition or not nonempty(definition.get('smiles')):
            missing[alias] = 'MISSING_DEFINITION'
        elif (definition.get('hashValidation') or {}).get('status') == 'MISMATCH':
            missing[alias] = 'HASH_MISMATCH'
        elif ((definition.get('hashValidation') or {}).get('status') != 'MATCH'
              or definition.get('validatedDefinition') is not True
              or not nonempty((definition.get('chemistry') or {}).get('canonicalSmiles'))):
            missing[alias] = 'UNVALIDATED_DEFINITION'
    return known, used, missing


def evidence_ids(snapshot, dossier):
    known = set()
    for collection in ('sampleMeasurements', 'historicalSampleMeasurements'):
        known.update(r.get('measurementAlias') for r in snapshot.get(collection, []) if nonempty(r.get('measurementAlias')))
    known.update(e.get('code') for e in snapshot.get('experimentSummaries', []) if nonempty(e.get('code')))
    for project in dossier.get('projects', []):
        known.update(s.get('stratumId') for s in project.get('strata', []) if nonempty(s.get('stratumId')))
    known.update(e.get('entryId') for e in dossier.get('ledgerEntries', []) if nonempty(e.get('entryId')))
    return known


def _validate(document, snapshot, dossier):
    errors = []
    def error(code, path):
        errors.append({'code': code, 'path': path})
    if not all(isinstance(value, dict) for value in (document, snapshot, dossier)):
        return {'passed': False, 'errors': [{'code': 'INVALID_INPUT_OBJECT', 'path': 'inputs'}]}
    primary_result = primary_gate.validate(document, snapshot, dossier)
    errors.extend(primary_result['errors'])
    # Historical immutable papers retain their reviewed contract. The current
    # workflow additionally runs the standalone language gate, which requires
    # the new envelope; its presence also makes this integrated gate fail closed.
    if 'languageReview' in document:
        errors.extend(language_gate.validate(document)['errors'])
    if snapshot.get('readOnly') is not True or snapshot.get('truncated') is not False:
        error('UNVERIFIED_OR_TRUNCATED_SNAPSHOT', 'snapshot')
    if dossier.get('readOnlyAnalysis') is not True or dossier.get('schemaVersion') != 1:
        error('UNVERIFIED_DOSSIER', 'dossier')
    try:
        for key, value in [('snapshotAt', snapshot.get('snapshotAt')),
                           ('windowStart', snapshot.get('contextStart') or snapshot.get('windowStart')),
                           ('windowEnd', snapshot.get('windowEnd'))]:
            if time(document.get(key)) != time(value):
                error('DOCUMENT_SNAPSHOT_DATE_MISMATCH', key)
        if time(dossier.get('snapshotAt')) != time(snapshot.get('snapshotAt')):
            error('DOSSIER_SNAPSHOT_DATE_MISMATCH', 'dossier.snapshotAt')
        if not time(document.get('windowStart')) < time(document.get('windowEnd')) <= time(document.get('snapshotAt')) <= time(document.get('generatedAt')) + dt.timedelta(seconds=60):
            error('UNORDERED_DOCUMENT_DATES', 'dates')
    except (ValueError, TypeError):
        error('INVALID_OFFSET_AWARE_DATE', 'dates')
    public_values = []
    for key in ('titleEn', 'titleZh', 'summaryEn', 'summaryZh'):
        if not nonempty(document.get(key)):
            error('MISSING_BILINGUAL_TEXT', key)
        else:
            public_values.append(document[key])
    sections = document.get('sections')
    section_ids, hrefs, bodies = set(), set(), {}
    if not isinstance(sections, list) or not sections:
        error('MISSING_BILINGUAL_SECTIONS', 'sections')
        sections = []
    for index, section in enumerate(sections):
        path = f'sections[{index}]'
        if not isinstance(section, dict):
            error('INVALID_SECTION', path)
            continue
        sid = section.get('id')
        if not nonempty(sid) or not SECTION_ID.fullmatch(sid):
            error('INVALID_SECTION_ID', path + '.id')
        elif sid in section_ids:
            error('DUPLICATE_SECTION_ID', path + '.id')
        else:
            section_ids.add(sid)
        for key in ('titleEn', 'titleZh', 'bodyEn', 'bodyZh'):
            value = section.get(key)
            if not nonempty(value):
                error('INCOMPLETE_BILINGUAL_SECTION', path + '.' + key)
                continue
            public_values.append(value)
            if key.startswith('body'):
                plain, parsed = html_plain(value)
                hrefs.update(parsed.hrefs)
                bodies.setdefault(sid, []).append(plain)
                minimum = 40 if key == 'bodyEn' else 20
                if len(re.sub(r'\s+', '', plain)) < minimum:
                    error('NON_SUBSTANTIVE_SECTION_BODY', path + '.' + key)
                if key == 'bodyZh' and len(re.findall(r'[\u3400-\u9fff]', plain)) < 5:
                    error('MISSING_SUBSTANTIVE_CHINESE', path + '.' + key)
                for violation in sorted(parsed.violations):
                    error(violation, path + '.' + key)
    if sum(len(v.encode('utf-8')) for v in public_values) > 2_000_000:
        error('PUBLIC_DOCUMENT_TOO_LARGE', 'document')
    if any(DESCRIPTOR_KEYS.search(decoded(value)) for value in public_values):
        error('PRIVATE_DESCRIPTOR_OR_EVIDENCE_PAYLOAD', 'publicContent')
    leak = private_leak(public_values, snapshot)
    if leak['longNotationMatches'] or leak['shortNotationMatches']:
        error('PRIVATE_MOLECULAR_NOTATION_LEAK', 'publicContent')
    review = document.get('rdReview')
    if not isinstance(review, dict) or review.get('schemaVersion') != 1:
        error('MISSING_RD_REVIEW_ENVELOPE', 'rdReview')
        review = {}
    inventory = snapshot.get('projectInventory')
    if not isinstance(inventory, list) or not inventory:
        error('MISSING_CANONICAL_PROJECT_INVENTORY', 'snapshot.projectInventory')
        inventory = []
    expected_projects = {project_alias(p.get('projectAlias')) for p in inventory}
    expected_projects.add('UNASSIGNED')
    aliases = review.get('projectAliases')
    if not unique_strings(aliases) or set(aliases or []) != expected_projects:
        error('INCOMPLETE_OR_DUPLICATE_PROJECT_COVERAGE', 'rdReview.projectAliases')
    roles = review.get('sectionIds')
    if not isinstance(roles, dict) or not ROLES.issubset(roles):
        error('MISSING_SUBSTANTIVE_SECTION_ROLES', 'rdReview.sectionIds')
        roles = {}
    for role, sid in roles.items():
        if sid not in section_ids:
            error('UNKNOWN_LINKED_SECTION', 'rdReview.sectionIds.' + role)
    marks = review.get('reviewMarks')
    if not isinstance(marks, dict) or any(marks.get(mark) is not True for mark in MARKS):
        error('MISSING_EXPLICIT_REVIEW_MARKS', 'rdReview.reviewMarks')
    if not nonempty(review.get('reviewedBy')):
        error('MISSING_REVIEWER', 'rdReview.reviewedBy')
    try:
        if time(review.get('reviewedAt')) < time(snapshot.get('snapshotAt')):
            error('REVIEW_PREDATES_SNAPSHOT', 'rdReview.reviewedAt')
    except (ValueError, TypeError):
        error('MISSING_REVIEW_TIME', 'rdReview.reviewedAt')
    known_evidence = evidence_ids(snapshot, dossier)
    def check_refs(refs, path, allow_empty=False):
        if not unique_strings(refs, allow_empty=allow_empty):
            error('MISSING_OR_DUPLICATE_EVIDENCE_IDS', path)
        elif not set(refs).issubset(known_evidence):
            error('UNKNOWN_EVIDENCE_IDS', path)
    def check_identity(item, path, ids):
        if not nonempty(item.get('id')) or not IDENTIFIER.fullmatch(item['id']):
            error('INVALID_REVIEW_ITEM_ID', path + '.id')
        elif item['id'] in ids:
            error('DUPLICATE_REVIEW_ITEM_ID', path + '.id')
        else:
            ids.add(item['id'])
        if item.get('projectAlias') not in expected_projects:
            error('UNKNOWN_PROJECT_REFERENCE', path + '.projectAlias')
        if item.get('sectionId') not in section_ids:
            error('UNKNOWN_LINKED_SECTION', path + '.sectionId')
    item_ids = set()
    actions = review.get('priorityActions')
    if not isinstance(actions, list) or not actions:
        error('MISSING_ACTIONABLE_PRIORITIES', 'rdReview.priorityActions')
        actions = []
    for index, action in enumerate(actions):
        path = f'rdReview.priorityActions[{index}]'
        if not isinstance(action, dict):
            error('INVALID_PRIORITY_ACTION', path)
            continue
        check_identity(action, path, item_ids)
        for key in ('hypothesis', 'controlledTest', 'decisionCriterion'):
            if not nonempty(action.get(key)):
                error('INCOMPLETE_PRIORITY_ACTION', path + '.' + key)
        if action.get('priority') not in {'P0', 'P1', 'P2'}:
            error('INVALID_PRIORITY', path + '.priority')
        if action.get('confidence') not in {'LOW', 'MODERATE', 'HIGH'}:
            error('MISSING_EXPLICIT_CONFIDENCE', path + '.confidence')
        if action.get('status') != 'PROPOSED' or action.get('executed') not in (None, False):
            error('NEXT_ACTION_IS_NOT_A_PROPOSAL', path + '.status')
        check_refs(action.get('evidenceIds'), path + '.evidenceIds')
    known_materials, used_materials, missing_chemistry = material_coverage(snapshot)
    cards = review.get('mechanismCards')
    if not isinstance(cards, list) or not cards:
        error('MISSING_MECHANISM_ANALYSIS', 'rdReview.mechanismCards')
        cards = []
    for index, card in enumerate(cards):
        path = f'rdReview.mechanismCards[{index}]'
        if not isinstance(card, dict):
            error('INVALID_MECHANISM_CARD', path)
            continue
        check_identity(card, path, item_ids)
        for key in ('reasoning', 'discriminatingTest'):
            if not nonempty(card.get(key)):
                error('INCOMPLETE_MECHANISM_REASONING', path + '.' + key)
        if not unique_strings(card.get('alternatives')):
            error('MISSING_ALTERNATIVE_EXPLANATIONS', path + '.alternatives')
        check_refs(card.get('localEvidence'), path + '.localEvidence', allow_empty=True)
        if card.get('localEvidence') == [] and not nonempty(card.get('localEvidenceLimitation')):
            error('MISSING_LOCAL_EVIDENCE_LIMITATION', path + '.localEvidenceLimitation')
        materials = card.get('materialAliases')
        if materials is not None and (not unique_strings(materials, allow_empty=True) or not set(materials).issubset(known_materials)):
            error('UNKNOWN_OR_DUPLICATE_MATERIAL_ALIASES', path + '.materialAliases')
        literature = card.get('literatureEvidence')
        if not isinstance(literature, list) or not literature:
            error('MISSING_CITED_PUBLIC_LITERATURE', path + '.literatureEvidence')
            literature = []
        urls = set()
        for li, ref in enumerate(literature):
            ref_path = path + f'.literatureEvidence[{li}]'
            if not isinstance(ref, dict) or not public_https(ref.get('url')) or not nonempty(ref.get('claim')):
                error('INVALID_PUBLIC_LITERATURE_REFERENCE', ref_path)
                continue
            url = decoded(ref['url'])
            if url in urls:
                error('DUPLICATE_LITERATURE_REFERENCE', ref_path)
            urls.add(url)
            if url not in hrefs:
                error('LITERATURE_NOT_CITED_IN_REPORT', ref_path)
    limitations = review.get('chemistryLimitations')
    if not isinstance(limitations, list):
        error('MISSING_PRIVATE_CHEMISTRY_COVERAGE_REVIEW', 'rdReview.chemistryLimitations')
        limitations = []
    acknowledged = set()
    for index, limitation in enumerate(limitations):
        path = f'rdReview.chemistryLimitations[{index}]'
        if not isinstance(limitation, dict):
            error('INVALID_CHEMISTRY_LIMITATION', path)
            continue
        alias = limitation.get('materialAlias')
        if alias not in missing_chemistry or limitation.get('reason') != missing_chemistry.get(alias):
            error('UNSUPPORTED_CHEMISTRY_LIMITATION', path)
        elif alias in acknowledged:
            error('DUPLICATE_CHEMISTRY_LIMITATION', path)
        else:
            acknowledged.add(alias)
        if limitation.get('sectionId') not in section_ids:
            error('UNKNOWN_LINKED_SECTION', path + '.sectionId')
    if acknowledged != set(missing_chemistry):
        error('UNREPORTED_PRIVATE_CHEMISTRY_COVERAGE_GAPS', 'rdReview.chemistryLimitations')
    prior_ids = {r.get('id') for r in snapshot.get('reportMetadata', []) if nonempty(r.get('id'))}
    continuity = review.get('continuitySourceReportIds')
    if not unique_strings(continuity, allow_empty=not prior_ids) or not set(continuity or []).issubset(prior_ids):
        error('INVALID_CONTINUITY_REPORT_REFERENCES', 'rdReview.continuitySourceReportIds')
    if not prior_ids and not nonempty(review.get('continuityLimitation')):
        error('MISSING_CONTINUITY_BASELINE_LIMITATION', 'rdReview.continuityLimitation')
    return {'passed': not errors, 'gateVersion': 1, 'errors': errors,
            'counts': {'projectsRequired': len(expected_projects), 'sections': len(section_ids),
                       'priorityActions': len(actions), 'mechanismCards': len(cards),
                       'usedSamAdditiveMaterials': len(used_materials), 'chemistryCoverageGaps': len(missing_chemistry),
                       'privateNotationDefinitionsChecked': leak['definitionsChecked']},
            'limitations': ['Passing validates explicit review, coverage and mechanical privacy checks; it does not certify numerical claims, chemical identity, scientific causality or experimental execution.',
                            'Opaque body images are blocked; chart SVGs still require visual privacy review.',
                            'Current hash-valid chemical definitions do not establish historical lots or actual composition.']}


def validate(document, snapshot, dossier):
    """Malformed nested runtime input cannot bypass the gate or echo its values."""
    try:
        return _validate(document, snapshot, dossier)
    except (TypeError, AttributeError, KeyError, ValueError, OverflowError, RecursionError):
        return {'passed': False, 'gateVersion': 1,
                'errors': [{'code': 'INVALID_NESTED_INPUT_SHAPE', 'path': 'inputs'}],
                'counts': {}, 'limitations': ['The publication gate did not complete. No science was certified.']}


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
                      'counts': result.get('counts', {}), 'scienceCertified': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
