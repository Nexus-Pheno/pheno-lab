#!/usr/bin/env python3
"""Synthetic material-annex evidence/privacy contracts; no real molecular inputs."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('gate', BASE / 'validate_material_mechanism_review.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
PRIVATE = 'c1ccccc1'


def digest(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True).encode()).hexdigest()


def fixture():
    current_hash = hashlib.sha256(PRIVATE.encode()).hexdigest()
    current = {'materialAlias': 'sam-a', 'name': 'Synthetic SAM A', 'category': 'SAM', 'smiles': PRIVATE,
        'validatedDefinition': True, 'hashValidation': {'status': 'MATCH'},
        'chemistry': {'canonicalSmiles': PRIVATE, 'inputSha256': current_hash, 'version': 2,
                      'generatedAt': '2026-01-30T00:00:00Z', 'engineVersion': 'RDKit SYNTHETIC'}}
    missing = {'materialAlias': 'material-missing', 'name': 'Unresolved material', 'category': 'ADDITIVE',
               'smiles': '', 'chemistry': None, 'validatedDefinition': False, 'hashValidation': {'status': 'NO_DEFINITION'}}
    recipe = {'recipeAlias': 'recipe-a', 'name': 'Synthetic perovskite recipe',
              'payload': {'components': [{'material': 'Synthetic precursor', 'amount': 'source-only'}]},
              'historicalActualCompositionVerified': False}
    snapshot = {'schemaVersion': 1, 'readOnly': True, 'truncated': False,
        'snapshotAt': '2026-01-31T00:00:00Z', 'chemistryAccessAvailable': True,
        'privateChemistryDefinitions': [current, missing], 'experimentSummaries': [
            {'code': 'E-SYNTHETIC', 'steps': [{'recipe': recipe, 'materials': [{'material': current}], 'executions': []}]}]}
    descriptors = {'classification': 'PRIVATE_CHEMISTRY_DESCRIPTORS_DO_NOT_PUBLISH',
        'snapshotAt': snapshot['snapshotAt'], 'materials': [{'materialAlias': 'sam-a',
            'name': current['name'], 'definitionVersion': 2, 'generatedAt': current['chemistry']['generatedAt'],
            'historicalLotVerified': False,
            'status': 'VALIDATED_CURRENT_GRAPH', 'descriptors': {'formalCharge': 0, 'hBondDonors': 1},
            'motifCounts': {'neutralAmine': 0}}]}
    sources = {'snapshot.json': {'document': snapshot, 'sha256': digest(snapshot)},
               'private-descriptors.json': {'document': descriptors, 'sha256': digest(descriptors)}}
    context = {'experimentCode': 'E-SYNTHETIC', 'currentRecipeObjectPresent': True,
        'actualCapturesPresent': False, 'actualRecipeOrSAMSolventHistoricalIdentityVerified': False,
        'SAMCarrierContext': 'Carrier solvent is not captured as historical actual evidence.',
        'boundary': 'The recorded recipe is current planning context; actual historical composition remains unverified.',
        'currentRecipeContexts': [{'recipeAlias': 'recipe-a', 'evidenceBasis': 'CURRENT_PLAN_AT_SNAPSHOT',
            'coarseAbsorberContext': 'Lead-halide absorber family', 'solventRoleContext': 'Current precursor carrier context only.',
            'ingredientLinkBasis': 'RECORDED_TEXT_NOT_RELATIONAL_MATERIAL_IDS',
            'historicalActualCompositionVerified': False, 'formulaIngredientsRatiosConcentrationsOmitted': True}]}
    common = {'materialName': 'Synthetic SAM A', 'priority': 'Conditional confirmation after identity and protocol checks',
        'experimentEvidenceIds': ['E-SYNTHETIC'], 'recipeAndSolventEvidence': [context],
        'discriminatingControls': ['Hold substrate, recipe and scan protocol fixed while varying one proposed process.'],
        'competingExplanations': ['Substrate condition', 'Scan protocol'],
        'decisionCriteria': ['Advance only if independently repeated, matched observations support the proposed contrast; otherwise revise the hypothesis.'],
        'literatureSourceIds': ['L1'], 'fullStructureAndDescriptorVectorOmitted': True,
        'historicalIdentityAndMolecularCausalityConfirmed': False}
    graph = {'id': 'case-graph', 'status': gate.GRAPH_STATUS, **copy.deepcopy(common),
        'materialEvidence': {'materialAlias': 'sam-a', 'definitionStatus': 'VALIDATED_CURRENT_GRAPH_NOT_HISTORICAL_LOT_PROOF',
            'inputHashStatus': 'MATCH', 'inputSha256': current_hash, 'definitionVersion': 2,
            'definitionGeneratedAt': current['chemistry']['generatedAt'], 'localEngineVersion': current['chemistry']['engineVersion'],
            'historicalLotVerified': False, 'privateDescriptorFieldsConsulted': ['formalCharge', 'hBondDonors'],
            'privateMotifMatchersConsulted': ['neutralAmine'], 'descriptorValuesAndGraphOmitted': True},
        'privateGraphToMechanismInterpretation': ['A current graph permits a conditional interfacial hypothesis, not a historical composition claim.'],
        'localOutcome': 'Recorded observations need an independently matched confirmation.',
        'chemistryToRecipeCompatibility': ['Actual carrier and precursor exposure have not been confirmed.'],
        'reportSafeFutureSentence': 'Test the interface hypothesis under matched process conditions before ranking the material.'}
    blocked = {'id': 'case-blocked', 'status': gate.BLOCKED_STATUS, **copy.deepcopy(common),
        'materialName': 'Unresolved material', 'reason': 'No trusted definition belongs to the recorded identity.',
        'allowedCurrentReasoning': 'Describe the recorded process only; defer molecule-specific interpretation.',
        'recordedCaseAliases': ['material-missing'], 'candidateAlternateAliases': [],
        'candidateMappingStatus': 'NOT_CONFIRMED_DO_NOT_SUBSTITUTE',
        'materialEvidence': {'definitionStatus': 'MISSING_FOR_CASE_IDENTITY', 'historicalLotVerified': False,
                             'descriptorValuesAndGraphOmitted': True}}
    annex = {'schemaVersion': 1, 'classification': gate.CLASSIFICATION, 'reviewedAt': '2026-01-31T00:01:00Z',
        'snapshotAt': snapshot['snapshotAt'], 'scope': 'Private current-graph reasoning with explicit historical limits.',
        'publicationStatus': 'PRIVATE_FUTURE_WORKFLOW_INPUT_ONLY_NOT_PUBLISHED',
        'inputs': [{'file': name, 'sha256': record['sha256']} for name, record in sources.items()],
        'sourceLibrary': {'L1': 'https://example.com/primary-paper'}, 'materialCases': [graph, blocked],
        'graphSupportedExactCaseMaterials': 1, 'limitations': ['Current graphs do not verify historical lots or actual solvents.']}
    return annex, snapshot, sources


class MaterialAnnexGate(unittest.TestCase):
    def invalid(self, annex, snapshot, sources, code):
        result = gate.validate(annex, snapshot, sources)
        self.assertFalse(result['passed'])
        self.assertIn(code, {error['code'] for error in result['errors']})
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_valid_current_graph_and_honest_missing_identity(self):
        result = gate.validate(*fixture())
        self.assertTrue(result['passed'], result['errors'])
        self.assertEqual(result['counts']['uniqueHashValidGraphAliases'], 1)
        self.assertEqual(result['counts']['blockedIdentityCases'], 1)
        self.assertFalse(result['scienceCertified'])

    def test_snapshot_and_source_hashes_are_exact(self):
        for change, code in [
            (lambda a: a.update(snapshotAt='2026-01-31T00:02:00Z'), 'ANNEX_SNAPSHOT_DATE_MISMATCH'),
            (lambda a: a['inputs'][0].update(sha256='0' * 64), 'INPUT_HASH_REFERENCE_MISMATCH'),
            (lambda a: a['inputs'][0].update(file='../snapshot.json'), 'DUPLICATE_OR_ESCAPING_INPUT_REFERENCE'),
            (lambda a: a['inputs'].pop(0), 'SNAPSHOT_INPUT_NOT_BOUND')]:
            annex, snapshot, sources = fixture()
            change(annex)
            self.invalid(annex, snapshot, sources, code)

    def test_exact_alias_hash_and_name_cannot_be_substituted(self):
        for change, code in [
            (lambda a: a['materialCases'][0]['materialEvidence'].update(materialAlias='guessed-from-name'), 'GRAPH_CASE_HAS_NO_CURRENT_HASH_VALID_ALIAS'),
            (lambda a: a['materialCases'][0].update(materialName='Another material'), 'GRAPH_CASE_NAME_ALIAS_SUBSTITUTION'),
            (lambda a: a['materialCases'][0]['materialEvidence'].update(inputSha256='0' * 64), 'GRAPH_DEFINITION_EVIDENCE_METADATA_MISMATCH'),
            (lambda a: a['materialCases'][0]['materialEvidence'].update(definitionVersion=1), 'GRAPH_DEFINITION_EVIDENCE_METADATA_MISMATCH')]:
            annex, snapshot, sources = fixture()
            change(annex)
            self.invalid(annex, snapshot, sources, code)
        annex, snapshot, sources = fixture()
        snapshot['privateChemistryDefinitions'][0]['smiles'] = 'CCN'
        self.invalid(annex, snapshot, sources, 'GRAPH_CASE_HAS_NO_CURRENT_HASH_VALID_ALIAS')

    def test_missing_or_revoked_chemistry_cannot_support_graph_case(self):
        annex, snapshot, sources = fixture()
        snapshot['chemistryAccessAvailable'] = False
        self.invalid(annex, snapshot, sources, 'GRAPH_CASE_HAS_NO_CURRENT_HASH_VALID_ALIAS')
        annex, snapshot, sources = fixture()
        snapshot['privateChemistryDefinitions'][0]['validatedDefinition'] = False
        self.invalid(annex, snapshot, sources, 'GRAPH_CASE_HAS_NO_CURRENT_HASH_VALID_ALIAS')

    def test_recipe_plan_and_actual_presence_are_not_guessed(self):
        for change, code in [
            (lambda a: a['materialCases'][0]['recipeAndSolventEvidence'][0].update(actualCapturesPresent=True), 'RECIPE_ACTUAL_PRESENCE_MISMATCH'),
            (lambda a: a['materialCases'][0]['recipeAndSolventEvidence'][0].update(actualRecipeOrSAMSolventHistoricalIdentityVerified=True), 'FALSE_VERIFIED_ACTUAL_RECIPE_OR_SOLVENT'),
            (lambda a: a['materialCases'][0]['recipeAndSolventEvidence'][0]['currentRecipeContexts'][0].update(recipeAlias='unrecorded'), 'UNVERIFIED_OR_DUPLICATE_CURRENT_RECIPE_ALIAS'),
            (lambda a: a['materialCases'][0]['recipeAndSolventEvidence'][0]['currentRecipeContexts'][0].update(historicalActualCompositionVerified=True), 'FALSE_HISTORICAL_RECIPE_OR_EXPOSED_FORMULATION'),
            (lambda a: a['materialCases'][0]['recipeAndSolventEvidence'][0].update(boundary=''), 'MISSING_PLANNED_ACTUAL_SOLVENT_LIMITATION')]:
            annex, snapshot, sources = fixture()
            change(annex)
            self.invalid(annex, snapshot, sources, code)

    def test_mechanism_alternatives_discriminator_decision_and_sources_required(self):
        for change, code in [
            (lambda a: a['materialCases'][0].update(privateGraphToMechanismInterpretation=[]), 'MISSING_CONDITIONAL_GRAPH_MECHANISM_REASONING'),
            (lambda a: a['materialCases'][0].update(competingExplanations=[]), 'MISSING_COMPETING_CAUSES'),
            (lambda a: a['materialCases'][0].update(discriminatingControls=[]), 'MISSING_DISCRIMINATING_CONTROLS'),
            (lambda a: a['materialCases'][0].update(decisionCriteria=[]), 'MISSING_EXPLICIT_DECISION_CRITERIA'),
            (lambda a: a['materialCases'][0].update(literatureSourceIds=['not-known']), 'UNKNOWN_OR_MISSING_LITERATURE_SOURCE_IDS'),
            (lambda a: a['sourceLibrary'].update(L1='http://example.com/paper'), 'INVALID_PUBLIC_LITERATURE_SOURCE')]:
            annex, snapshot, sources = fixture()
            change(annex)
            self.invalid(annex, snapshot, sources, code)

    def test_historical_lot_and_causality_claims_always_fail(self):
        for key in ('historicalLotVerified', 'descriptorValuesAndGraphOmitted'):
            annex, snapshot, sources = fixture()
            annex['materialCases'][0]['materialEvidence'][key] = (key == 'historicalLotVerified')
            self.invalid(annex, snapshot, sources, 'FALSE_VERIFIED_HISTORICAL_LOT_OR_CAUSALITY' if key == 'historicalLotVerified' else 'MISSING_EXPLICIT_GRAPH_VECTOR_OMISSION')
        annex, snapshot, sources = fixture()
        annex['materialCases'][0]['historicalIdentityAndMolecularCausalityConfirmed'] = True
        self.invalid(annex, snapshot, sources, 'FALSE_VERIFIED_HISTORICAL_LOT_OR_CAUSALITY')

    def test_descriptor_consultation_is_source_bound_including_zero_counts(self):
        annex, snapshot, sources = fixture()
        annex['materialCases'][0]['materialEvidence']['privateMotifMatchersConsulted'] = ['not-a-source-matcher']
        self.invalid(annex, snapshot, sources, 'UNVERIFIED_PRIVATE_DESCRIPTOR_CONSULTATION')
        annex, snapshot, sources = fixture()
        annex['materialCases'][0]['materialEvidence']['privateDescriptorFieldsConsulted'] = ['invented-energy-level']
        self.invalid(annex, snapshot, sources, 'UNVERIFIED_PRIVATE_DESCRIPTOR_CONSULTATION')
        self.assertTrue(gate.validate(*fixture())['passed'])  # Recorded zero still means consulted.
        annex, snapshot, sources = fixture()
        sources['private-descriptors.json']['document']['materials'][0]['definitionVersion'] = 1
        self.invalid(annex, snapshot, sources, 'UNVERIFIED_PRIVATE_DESCRIPTOR_CONSULTATION')

    def test_missing_identity_cannot_silently_import_an_alternate_graph(self):
        annex, snapshot, sources = fixture()
        annex['materialCases'][1]['candidateMappingStatus'] = 'ACCEPTED_BY_NAME'
        self.invalid(annex, snapshot, sources, 'MISSING_IDENTITY_BLOCK_NOT_EXPLICIT')
        annex, snapshot, sources = fixture()
        annex['materialCases'][1]['privateGraphToMechanismInterpretation'] = ['Speculative substitute graph claim.']
        self.invalid(annex, snapshot, sources, 'MISSING_IDENTITY_CASE_CONTAINS_MOLECULE_SPECIFIC_REASONING')
        annex, snapshot, sources = fixture()
        annex['materialCases'][1]['recordedCaseAliases'] = []
        self.assertTrue(gate.validate(annex, snapshot, sources)['passed'])

    def test_no_raw_notation_formula_vector_or_graph_copied(self):
        for change, code in [
            (lambda a: a['materialCases'][0].update(localOutcome=PRIVATE), 'PRIVATE_GRAPH_NOTATION_COPIED_INTO_ANNEX'),
            (lambda a: a['materialCases'][0].update(localOutcome=quote(PRIVATE, safe='')), 'PRIVATE_GRAPH_NOTATION_COPIED_INTO_ANNEX'),
            (lambda a: a['materialCases'][0].update(localOutcome='The formula is C6H6.'), 'MOLECULAR_FORMULA_LITERAL'),
            (lambda a: a['materialCases'][0].update(descriptors={'formalCharge': 0}), 'RAW_GRAPH_FORMULA_OR_DESCRIPTOR_PAYLOAD_KEY'),
            (lambda a: a['materialCases'][0].update(localOutcome='formalCharge = 0'), 'GRAPH_OR_DESCRIPTOR_VECTOR_LITERAL'),
            (lambda a: a['materialCases'][0].update(localOutcome="<svg><path class='bond-0 atom-0'/></svg>"), 'GRAPH_OR_DESCRIPTOR_VECTOR_LITERAL')]:
            annex, snapshot, sources = fixture()
            change(annex)
            self.invalid(annex, snapshot, sources, code)

    def test_normal_abbreviations_allowed_but_explicit_formula_is_blocked(self):
        annex, snapshot, sources = fixture()
        annex['materialCases'][0]['localOutcome'] = 'FF is a recorded outcome; canonical IDs and IP restrictions remain unchanged.'
        self.assertTrue(gate.validate(annex, snapshot, sources)['passed'])
        annex['materialCases'][0]['localOutcome'] = 'Chemical formula: FF'
        self.invalid(annex, snapshot, sources, 'MOLECULAR_FORMULA_LITERAL')

    def test_unique_cases_alias_counts_and_runtime_shapes(self):
        annex, snapshot, sources = fixture()
        annex['materialCases'].append(copy.deepcopy(annex['materialCases'][0]))
        self.invalid(annex, snapshot, sources, 'MISSING_OR_DUPLICATE_CASE_ID')
        annex, snapshot, sources = fixture()
        annex['graphSupportedExactCaseMaterials'] = 2
        self.invalid(annex, snapshot, sources, 'GRAPH_SUPPORTED_UNIQUE_ALIAS_COUNT_MISMATCH')
        annex['materialCases'][0]['materialEvidence']['materialAlias'] = {'malformed': PRIVATE}
        result = gate.validate(annex, snapshot, sources)
        self.assertFalse(result['passed'])
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_cli_hash_bound_private_files_and_changed_input_fail_closed(self):
        annex, snapshot, sources = fixture()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, source in sources.items():
                path = root / name
                data = json.dumps(source['document']).encode()
                with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as stream:
                    stream.write(data)
                for item in annex['inputs']:
                    if item['file'] == name:
                        item['sha256'] = hashlib.sha256(data).hexdigest()
            path = root / 'annex.json'
            with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
                json.dump(annex, stream)
            output = root / 'gate.json'
            command = [sys.executable, str(BASE / 'validate_material_mechanism_review.py'), str(path), str(root / 'snapshot.json')]
            completed = subprocess.run([*command, '--output', str(output)], capture_output=True, text=True, check=True)
            self.assertTrue(json.loads(completed.stdout)['passed'])
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertNotIn(PRIVATE, completed.stdout + output.read_text())
            with (root / 'private-descriptors.json').open('a') as stream:
                stream.write(' ')
            completed = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 1)
            self.assertIn('INPUT_HASH_REFERENCE_MISMATCH', json.loads(completed.stdout)['errorCodes'])

    def test_escaping_snapshot_is_rejected_before_private_inputs_are_read(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            root = Path(temp)
            annex_path = root / 'annex.json'
            annex_path.write_text('{}')
            snapshot_path = Path(outside) / 'snapshot.json'
            snapshot_path.write_text('{}')
            with mock.patch.object(gate, 'load_private') as read:
                result = gate.validate_files(annex_path, snapshot_path)
                self.assertFalse(result['passed'])
                read.assert_not_called()
            link = root / 'snapshot.json'
            link.symlink_to(snapshot_path)
            with mock.patch.object(gate, 'load_private') as read:
                result = gate.validate_files(annex_path, link)
                self.assertFalse(result['passed'])
                read.assert_not_called()

    def test_declared_hash_bound_new_descriptor_filename_excludes_stale_source(self):
        annex, snapshot, sources = fixture()
        current = sources.pop('private-descriptors.json')
        new_name = 'private-chemistry-dossier-v3.json'
        sources[new_name] = current
        for reference in annex['inputs']:
            if reference['file'] == 'private-descriptors.json':
                reference['file'] = new_name
        stale = copy.deepcopy(current)
        stale['document']['materials'][0]['motifCounts'] = {}
        sources['private-chemistry-dossier.json'] = stale  # Explicitly not declared.
        result = gate.validate(annex, snapshot, sources)
        self.assertTrue(result['passed'], result['errors'])
        # If the actual declared source lacks consultation, the check stays strict.
        sources[new_name]['document']['materials'][0]['motifCounts'] = {}
        self.invalid(annex, snapshot, sources, 'UNVERIFIED_PRIVATE_DESCRIPTOR_CONSULTATION')

    def test_file_loader_reads_only_declared_new_descriptor_artifact(self):
        from unittest import mock
        annex, snapshot, sources = fixture()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            new_name = 'private-chemistry-dossier-v3.json'
            for name, record in sources.items():
                file_name = new_name if name == 'private-descriptors.json' else name
                data = json.dumps(record['document']).encode()
                with os.fdopen(os.open(root / file_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as stream:
                    stream.write(data)
                for reference in annex['inputs']:
                    if reference['file'] == name:
                        reference.update(file=file_name, sha256=hashlib.sha256(data).hexdigest())
            old = root / 'private-chemistry-dossier.json'
            old.write_text('STALE_SYNTHETIC_ARTIFACT_MUST_NOT_BE_READ')
            annex_path = root / 'annex.json'
            with os.fdopen(os.open(annex_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
                json.dump(annex, stream)
            with mock.patch.object(gate, 'load_private', wraps=gate.load_private) as read:
                result = gate.validate_files(annex_path, root / 'snapshot.json')
                self.assertTrue(result['passed'], result['errors'])
                loaded_names = {call.args[0].name for call in read.call_args_list}
                self.assertIn(new_name, loaded_names)
                self.assertNotIn(old.name, loaded_names)


if __name__ == '__main__':
    unittest.main()
