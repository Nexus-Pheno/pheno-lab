#!/usr/bin/env python3
"""Synthetic privacy/coverage publication gate tests; no actual chemistry/data."""
import copy
import contextlib
import html
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from urllib.parse import quote

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('gate', BASE / 'validate_rd_document.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
PRIVATE_LONG = 'O=P(O)(O)CCn1c2ccccc2c2ccccc21'
PUBLIC_URL = 'https://example.com/primary-study'


def fixture():
    material = {'materialAlias': 'sam-a', 'name': 'Synthetic SAM', 'category': 'SAM'}
    absent = {'materialAlias': 'additive-gap', 'name': 'Synthetic additive', 'category': 'ADDITIVE'}
    snapshot = {'schemaVersion': 1, 'readOnly': True, 'truncated': False,
        'snapshotAt': '2026-01-31T01:00:00Z', 'contextStart': '2026-01-01T00:00:00Z',
        'windowStart': '2026-01-01T00:00:00Z', 'windowEnd': '2026-01-31T00:00:00Z',
        'chemistryAccessAvailable': True,
        'projectInventory': [{'projectAlias': 'project-a'}, {'projectAlias': 'project-empty'}, {'projectAlias': None}],
        'experimentSummaries': [{'code': 'E-SYNTHETIC-1', 'steps': [
            {'materials': [{'material': material}, {'material': absent}], 'executions': []}]}],
        'sampleMeasurements': [{'measurementAlias': 'scan-001'}], 'historicalSampleMeasurements': [],
        'privateChemistryDefinitions': [
            {'materialAlias': 'sam-a', 'smiles': PRIVATE_LONG,
             'chemistry': {'canonicalSmiles': PRIVATE_LONG}, 'hashValidation': {'status': 'MATCH'}, 'validatedDefinition': True},
            {'materialAlias': 'solvent-a', 'smiles': 'CCO', 'chemistry': {'canonicalSmiles': 'CCO'},
             'hashValidation': {'status': 'MATCH'}, 'validatedDefinition': True}],
        'reportMetadata': [{'id': 'prior-report-1'}]}
    dossier = {'schemaVersion': 1, 'readOnlyAnalysis': True, 'snapshotAt': snapshot['snapshotAt'],
               'projects': [{'projectAlias': 'project-a', 'strata': [{'stratumId': 'stratum-001'}]}],
               'ledgerEntries': [{'entryId': 'hypothesis-001'}]}
    english = '<p>This is a substantive synthetic reviewed research section. It separates observations from proposed experiments and records its uncertainty.</p>'
    chinese = '<p>这是用于合成测试的完整研发分析段落，明确区分现有观测与尚未执行的实验建议，并注明分析的不确定性和适用限制。</p>'
    sections = [{'id': role, 'titleEn': role.title(), 'titleZh': '合成研究分析', 'bodyEn': english, 'bodyZh': chinese}
                for role in sorted(gate.ROLES)]
    sections[-1]['bodyEn'] += '<p><a href="' + PUBLIC_URL + '">Primary scientific source</a></p>'
    sections[-1]['bodyZh'] += '<p><a href="' + PUBLIC_URL + '">原始科研文献</a></p>'
    document = {'titleEn': 'Synthetic weekly research report', 'titleZh': '合成测试每周研发报告',
        'summaryEn': 'Observed evidence and proposed next steps with explicit uncertainty.',
        'summaryZh': '明确注明不确定性的观察证据和后续研发建议。',
        'generatedAt': '2026-01-31T01:10:00Z', 'snapshotAt': snapshot['snapshotAt'],
        'windowStart': snapshot['windowStart'], 'windowEnd': snapshot['windowEnd'], 'sections': sections,
        'rdReview': {'schemaVersion': 1, 'projectAliases': ['project-a', 'project-empty', 'UNASSIGNED'],
            'sectionIds': {role: role for role in gate.ROLES},
            'priorityActions': [{'id': 'priority-001', 'projectAlias': 'project-a', 'priority': 'P1',
                'hypothesis': 'A controlled contrast can test whether the recorded process contributes to dispersion.',
                'evidenceIds': ['scan-001', 'stratum-001', 'hypothesis-001'],
                'controlledTest': 'Keep substrate, recipe and scan protocol constant; randomize samples and repeat independent batches.',
                'decisionCriterion': 'Compare sample median and dispersion before selecting the next confirmation candidate.',
                'confidence': 'LOW', 'status': 'PROPOSED', 'sectionId': 'priorities'}],
            'mechanismCards': [{'id': 'mechanism-001', 'projectAlias': 'project-a', 'sectionId': 'mechanisms',
                'materialAliases': ['sam-a'], 'localEvidence': ['scan-001'],
                'literatureEvidence': [{'url': PUBLIC_URL, 'claim': 'The public source supports a process-sensitive interface mechanism.'}],
                'reasoning': 'A plausible interfacial process could influence consistency; this is a testable interpretation.',
                'alternatives': ['Uncontrolled substrate condition', 'Differences in scan protocol'],
                'discriminatingTest': 'Match substrate and measurement protocol while changing only the proposed variable.'}],
            'continuitySourceReportIds': ['prior-report-1'],
            'chemistryLimitations': [{'materialAlias': 'additive-gap', 'reason': 'MISSING_DEFINITION', 'sectionId': 'limitations'}],
            'reviewedBy': 'Synthetic agent review', 'reviewedAt': '2026-01-31T01:09:00Z',
            'reviewMarks': {mark: True for mark in gate.MARKS}}}
    return document, snapshot, dossier


class ReportGate(unittest.TestCase):
    def check_invalid(self, document, snapshot, dossier, code):
        result = gate.validate(document, snapshot, dossier)
        self.assertFalse(result['passed'])
        self.assertIn(code, {e['code'] for e in result['errors']})
        self.assertNotIn(PRIVATE_LONG, json.dumps(result))
        return result

    def test_complete_contract_passes_without_science_certification(self):
        result = gate.validate(*fixture())
        self.assertTrue(result['passed'], result['errors'])
        self.assertEqual(result['counts']['projectsRequired'], 3)
        self.assertEqual(result['counts']['chemistryCoverageGaps'], 1)
        self.assertIn('does not certify', result['limitations'][0])

    def test_private_notation_raw_entity_percent_nested_and_tag_split(self):
        for notation in (PRIVATE_LONG, html.escape(PRIVATE_LONG),
                         ''.join('&#' + str(ord(c)) + ';' for c in PRIVATE_LONG),
                         quote(PRIVATE_LONG, safe=''), quote(quote(PRIVATE_LONG, safe=''), safe=''),
                         ' '.join(PRIVATE_LONG), '<span>' + '</span><span>'.join(PRIVATE_LONG) + '</span>'):
            document, snapshot, dossier = fixture()
            document['sections'][0]['bodyEn'] += '<p>' + notation + '</p>'
            with self.subTest(encoding=notation[:10]):
                self.check_invalid(document, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_short_private_notation_has_exact_boundaries(self):
        document, snapshot, dossier = fixture()
        document['sections'][0]['bodyEn'] += '<p>ACCOMMODATION remains an ordinary word, with no submitted molecule printed.</p>'
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])
        for notation in ('CCO', 'C C O', '%43%43%4f', '&#67;&#67;&#79;'):
            doc = copy.deepcopy(document)
            doc['sections'][0]['bodyEn'] += '<p>' + notation + '</p>'
            self.check_invalid(doc, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_canonical_private_notation_is_also_checked(self):
        document, snapshot, dossier = fixture()
        snapshot['privateChemistryDefinitions'][0]['smiles'] = 'SYNTHETIC_DIFFERENT_INPUT'
        document['summaryEn'] += ' ' + PRIVATE_LONG
        self.check_invalid(document, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_unvalidated_legacy_substrate_letter_does_not_ban_group_labels(self):
        document, snapshot, dossier = fixture()
        snapshot['privateChemistryDefinitions'].append({'materialAlias': 'legacy-substrate',
            'category': 'SUBSTRATE_MAT', 'smiles': 'N', 'chemistry': None,
            'validatedDefinition': False, 'hashValidation': {'status': 'NO_EVIDENCE'}})
        document['sections'][0]['bodyEn'] += '<p>Group N is a recorded treatment label. Molecular notation is omitted from this report; N remains only the group label.</p>'
        document['sections'][0]['bodyZh'] += '<p>N 组是现有实验的分组名称，报告不披露任何分子表达式。</p>'
        result = gate.validate(document, snapshot, dossier)
        self.assertTrue(result['passed'], result['errors'])
        self.assertEqual(result['counts']['privateNotationDefinitionsChecked'], 3)

    def test_legacy_single_letter_still_blocked_in_explicit_notation_contexts(self):
        for fragment in ('<p>SMILES: N</p>', '<p>SMILES: &#78;</p>',
                         '<p>SMILES = %4e</p>', '<p>Molecular formula: N</p>',
                         '<p>化学式：N</p>', '<p>结构式为 N</p>',
                         '<code>N</code>', '<pre>{"smiles": "N"}</pre>'):
            document, snapshot, dossier = fixture()
            snapshot['privateChemistryDefinitions'].append({'materialAlias': 'legacy-substrate',
                'category': 'SUBSTRATE_MAT', 'smiles': 'N', 'chemistry': None,
                'validatedDefinition': False, 'hashValidation': {'status': 'NO_EVIDENCE'}})
            document['sections'][0]['bodyEn'] += fragment
            self.check_invalid(document, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_private_evidence_and_longer_notation_never_get_legacy_exception(self):
        for definition, fragment in [
            ({'category': 'SUBSTRATE_MAT', 'smiles': 'N', 'chemistry': {'canonicalSmiles': 'N'},
              'validatedDefinition': True, 'hashValidation': {'status': 'MATCH'}}, '<p>Group N.</p>'),
            ({'category': 'SUBSTRATE_MAT', 'smiles': 'N', 'chemistry': {'canonicalSmiles': 'N'},
              'validatedDefinition': False, 'hashValidation': {'status': 'MISMATCH'}}, '<p>Group N.</p>'),
            ({'category': 'SAM', 'smiles': 'N', 'chemistry': None,
              'validatedDefinition': False, 'hashValidation': {'status': 'NO_EVIDENCE'}}, '<p>Group N.</p>'),
            ({'category': 'SUBSTRATE_MAT', 'smiles': 'NN', 'chemistry': None,
              'validatedDefinition': False, 'hashValidation': {'status': 'NO_EVIDENCE'}}, '<p>NN</p>'),
        ]:
            document, snapshot, dossier = fixture()
            definition['materialAlias'] = 'synthetic-other'
            snapshot['privateChemistryDefinitions'].append(definition)
            document['sections'][0]['bodyEn'] += fragment
            self.check_invalid(document, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')
        # Trusted evidence takes precedence over an unrelated ambiguous legacy card.
        document, snapshot, dossier = fixture()
        snapshot['privateChemistryDefinitions'] += [
            {'materialAlias': 'legacy-substrate', 'category': 'SUBSTRATE_MAT', 'smiles': 'N', 'chemistry': None,
             'validatedDefinition': False, 'hashValidation': {'status': 'NO_EVIDENCE'}},
            {'materialAlias': 'trusted-material', 'category': 'SAM', 'smiles': 'N',
             'chemistry': {'canonicalSmiles': 'N'}, 'validatedDefinition': True, 'hashValidation': {'status': 'MATCH'}}]
        document['sections'][0]['bodyEn'] += '<p>Group N.</p>'
        self.check_invalid(document, snapshot, dossier, 'PRIVATE_MOLECULAR_NOTATION_LEAK')

    def test_continuity_uses_report_id_not_publication_key(self):
        document, snapshot, dossier = fixture()
        snapshot['reportMetadata'][0]['publicationKey'] = 'materials-process-weekly-synthetic-v1'
        document['rdReview']['continuitySourceReportIds'] = ['materials-process-weekly-synthetic-v1']
        self.check_invalid(document, snapshot, dossier, 'INVALID_CONTINUITY_REPORT_REFERENCES')
        document['rdReview']['continuitySourceReportIds'] = ['prior-report-1']
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_rdkit_and_opaque_images_blocked_but_scientific_chart_allowed(self):
        for graph, code in [
            ("<svg><path class='bond-0 atom-0 atom-1' d='M0,0 L1,1'/></svg>", 'STRUCTURE_DIAGRAM_OR_ATTRIBUTE'),
            ("<svg xmlns:rdkit='http://www.rdkit.org/xml'/>", 'STRUCTURE_DIAGRAM_OR_ATTRIBUTE'),
            ("<svg><!-- RDKit generated structure --></svg>", 'STRUCTURE_DIAGRAM_COMMENT'),
            ("<img src='data:image/png;base64,AAAA' alt='structure'/>", 'DISALLOWED_BODY_ELEMENT'),
            ("<svg><image href='data:image/svg+xml;base64,AAAA'/></svg>", 'DISALLOWED_BODY_ELEMENT'),
            ("<a href='https://public.example.com/render?smiles=hidden'>Diagram</a>", 'STRUCTURE_URL')]:
            document, snapshot, dossier = fixture()
            document['sections'][0]['bodyEn'] += graph
            self.check_invalid(document, snapshot, dossier, code)
        document, snapshot, dossier = fixture()
        document['sections'][0]['bodyEn'] += "<svg role='img' viewBox='0 0 100 50'><title>Sample median PCE</title><rect x='10' y='10' width='20' height='20'/></svg>"
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_missing_project_or_unassigned_group_fails(self):
        for alias in ('project-empty', 'UNASSIGNED'):
            document, snapshot, dossier = fixture()
            document['rdReview']['projectAliases'].remove(alias)
            self.check_invalid(document, snapshot, dossier, 'INCOMPLETE_OR_DUPLICATE_PROJECT_COVERAGE')

    def test_empty_priorities_or_executed_claim_fails(self):
        document, snapshot, dossier = fixture()
        document['rdReview']['priorityActions'] = []
        self.check_invalid(document, snapshot, dossier, 'MISSING_ACTIONABLE_PRIORITIES')
        document, snapshot, dossier = fixture()
        document['rdReview']['priorityActions'][0]['status'] = 'EXECUTED'
        self.check_invalid(document, snapshot, dossier, 'NEXT_ACTION_IS_NOT_A_PROPOSAL')

    def test_duplicates_unknown_evidence_and_missing_decision_criterion(self):
        for change, code in [
            (lambda d: d['rdReview']['priorityActions'].append(copy.deepcopy(d['rdReview']['priorityActions'][0])), 'DUPLICATE_REVIEW_ITEM_ID'),
            (lambda d: d['sections'].append(copy.deepcopy(d['sections'][0])), 'DUPLICATE_SECTION_ID'),
            (lambda d: d['rdReview']['projectAliases'].append('project-a'), 'INCOMPLETE_OR_DUPLICATE_PROJECT_COVERAGE'),
            (lambda d: d['rdReview']['priorityActions'][0].update(evidenceIds=['not-known']), 'UNKNOWN_EVIDENCE_IDS'),
            (lambda d: d['rdReview']['priorityActions'][0].update(decisionCriterion=''), 'INCOMPLETE_PRIORITY_ACTION'),
            (lambda d: d['rdReview']['mechanismCards'][0].update(alternatives=[]), 'MISSING_ALTERNATIVE_EXPLANATIONS')]:
            document, snapshot, dossier = fixture()
            change(document)
            self.check_invalid(document, snapshot, dossier, code)

    def test_public_https_literature_must_be_present_as_citation(self):
        for url in ('http://example.com/article', 'https://localhost/article',
                    'https://127.0.0.1/article', 'https://lab.szkl.com/private',
                    'https://username:secret@example.com/article', 'https://research.internal/article'):
            document, snapshot, dossier = fixture()
            document['rdReview']['mechanismCards'][0]['literatureEvidence'][0]['url'] = url
            self.check_invalid(document, snapshot, dossier, 'INVALID_PUBLIC_LITERATURE_REFERENCE')
        document, snapshot, dossier = fixture()
        document['rdReview']['mechanismCards'][0]['literatureEvidence'][0]['url'] = 'https://example.com/not-cited'
        self.check_invalid(document, snapshot, dossier, 'LITERATURE_NOT_CITED_IN_REPORT')

    def test_no_local_evidence_requires_explicit_limitation(self):
        document, snapshot, dossier = fixture()
        card = document['rdReview']['mechanismCards'][0]
        card['localEvidence'] = []
        self.check_invalid(document, snapshot, dossier, 'MISSING_LOCAL_EVIDENCE_LIMITATION')
        card['localEvidenceLimitation'] = 'No matching source-linked local contrast is available; this mechanism is a literature-grounded hypothesis.'
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_missing_or_stale_chemistry_must_be_reported_as_limitation(self):
        document, snapshot, dossier = fixture()
        document['rdReview']['chemistryLimitations'] = []
        self.check_invalid(document, snapshot, dossier, 'UNREPORTED_PRIVATE_CHEMISTRY_COVERAGE_GAPS')
        document, snapshot, dossier = fixture()
        definition = snapshot['privateChemistryDefinitions'][0]
        definition['hashValidation']['status'] = 'MISMATCH'
        definition['validatedDefinition'] = False
        self.check_invalid(document, snapshot, dossier, 'UNREPORTED_PRIVATE_CHEMISTRY_COVERAGE_GAPS')
        document['rdReview']['chemistryLimitations'].append({'materialAlias': 'sam-a', 'reason': 'HASH_MISMATCH', 'sectionId': 'limitations'})
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_no_chemistry_grant_requires_full_coverage_limitation(self):
        document, snapshot, dossier = fixture()
        snapshot['chemistryAccessAvailable'] = False
        snapshot['privateChemistryDefinitions'] = []
        document['rdReview']['chemistryLimitations'] = [{'materialAlias': alias, 'reason': 'NO_CHEMISTRY_ACCESS', 'sectionId': 'limitations'}
                                                    for alias in ('sam-a', 'additive-gap')]
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_substantive_bilingual_roles_reviewmarks_and_continuity_required(self):
        for change, code in [
            (lambda d: d['sections'][0].update(bodyZh='<p>缺少</p>'), 'NON_SUBSTANTIVE_SECTION_BODY'),
            (lambda d: d['rdReview']['sectionIds'].pop('reproducibility'), 'MISSING_SUBSTANTIVE_SECTION_ROLES'),
            (lambda d: d['rdReview']['priorityActions'][0].update(sectionId='not-here'), 'UNKNOWN_LINKED_SECTION'),
            (lambda d: d['rdReview']['reviewMarks'].update(numericalClaims=False), 'MISSING_EXPLICIT_REVIEW_MARKS'),
            (lambda d: d['rdReview'].update(continuitySourceReportIds=[]), 'INVALID_CONTINUITY_REPORT_REFERENCES'),
            (lambda d: d.update(snapshotAt='2026-01-31T00:59:00Z'), 'DOCUMENT_SNAPSHOT_DATE_MISMATCH')]:
            document, snapshot, dossier = fixture()
            change(document)
            self.check_invalid(document, snapshot, dossier, code)
        document, snapshot, dossier = fixture()
        snapshot['reportMetadata'] = []
        document['rdReview']['continuitySourceReportIds'] = []
        self.check_invalid(document, snapshot, dossier, 'MISSING_CONTINUITY_BASELINE_LIMITATION')
        document['rdReview']['continuityLimitation'] = 'No prior published report exists; use this report as a clearly labeled starting baseline.'
        self.assertTrue(gate.validate(document, snapshot, dossier)['passed'])

    def test_no_private_descriptors_or_executable_content(self):
        for fragment, code in [('<p>TPSA = 35</p>', 'PRIVATE_DESCRIPTOR_OR_EVIDENCE_PAYLOAD'),
                               ('<script>console.log(1)</script>', 'DISALLOWED_BODY_ELEMENT'),
                               ('<p onclick="alert(1)">Synthetic text</p>', 'EXECUTABLE_BODY_ATTRIBUTE')]:
            document, snapshot, dossier = fixture()
            document['sections'][0]['bodyEn'] += fragment
            self.check_invalid(document, snapshot, dossier, code)

    def test_gate_cli_writes_private_aggregate_result(self):
        import sys
        document, snapshot, dossier = fixture()
        with tempfile.TemporaryDirectory() as temp:
            paths = [Path(temp) / name for name in ('document.json', 'snapshot.json', 'dossier.json')]
            for path, value in zip(paths, (document, snapshot, dossier)):
                path.write_text(json.dumps(value))
            output = Path(temp) / 'private' / 'gate.json'
            result = subprocess.run([sys.executable, str(BASE / 'validate_rd_document.py'),
                                     *map(str, paths), '--output', str(output)], capture_output=True, text=True, check=True)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertNotIn(PRIVATE_LONG, result.stdout)
            self.assertNotIn(PRIVATE_LONG, output.read_text())
            self.assertTrue(json.loads(result.stdout)['passed'])
            self.assertFalse(json.loads(result.stdout)['scienceCertified'])
            document['rdReview']['priorityActions'] = []
            paths[0].write_text(json.dumps(document))
            result = subprocess.run([sys.executable, str(BASE / 'validate_rd_document.py'), *map(str, paths)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)['passed'])

    def test_malformed_nested_shapes_fail_closed_without_echo(self):
        for change in (
            lambda d: d['rdReview']['sectionIds'].update(projects=['not-a-string']),
            lambda d: d['rdReview']['priorityActions'][0].update(priority={'secret': PRIVATE_LONG}),
            lambda d: d['rdReview']['priorityActions'][0].update(sectionId=['bad-shape']),
            lambda d: d['rdReview']['mechanismCards'][0].update(projectAlias={'secret': PRIVATE_LONG}),
        ):
            document, snapshot, dossier = fixture()
            change(document)
            result = gate.validate(document, snapshot, dossier)
            self.assertFalse(result['passed'])
            self.assertNotIn(PRIVATE_LONG, json.dumps(result))


if __name__ == '__main__':
    unittest.main()
