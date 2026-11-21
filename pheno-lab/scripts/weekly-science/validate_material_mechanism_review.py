#!/usr/bin/env python3
"""Gate a private material-mechanism annex without certifying its chemical claims.

Usage: validate_material_mechanism_review.py ANNEX SNAPSHOT [--output PRIVATE_GATE]
The existing annex remains private; only aggregate gate status is printed.
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
import stat
import sys

BASE = Path(__file__).parent
_spec = importlib.util.spec_from_file_location('material_review_privacy', BASE / 'validate_rd_document.py')
_privacy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_privacy)
SHA = re.compile(r'[0-9a-f]{64}\Z')
GRAPH_STATUS = 'CONDITIONAL_MOLECULE_SPECIFIC_HYPOTHESIS_CURRENT_GRAPH_ONLY'
BLOCKED_STATUS = 'MOLECULE_SPECIFIC_REASONING_BLOCKED_PENDING_IDENTITY'
CLASSIFICATION = 'PRIVATE_MATERIAL_MECHANISM_REVIEW_NONRECONSTRUCTIVE'
MAX_INPUT_BYTES = 512 * 1024 * 1024
FORBIDDEN_KEYS = {'smiles', 'canonicalsmiles', 'smarts', 'svg', 'structuresvg', 'molecularformula',
                  'chemicalformula', 'formula', 'descriptors', 'descriptorvector', 'descriptorvalues',
                  'featurevector', 'fingerprint', 'motifcounts'}
DESCRIPTOR_FIELDS = {'aromaticRings', 'calculatedLogP', 'formalCharge', 'fragments', 'hBondAcceptors',
                     'hBondDonors', 'heavyAtoms', 'molecularWeight', 'polarSurfaceArea', 'rotatableBonds'}
ELEMENTS = ('Ac Ag Al Am Ar As At Au B Ba Be Bi Bk Br C Ca Cd Ce Cf Cl Cm Cn Co Cr Cs Cu Db Ds Dy Er Es Eu F '
            'Fe Fl Fm Fr Ga Gd Ge H He Hf Hg Ho Hs I In Ir K Kr La Li Lr Lu Lv Mc Md Mg Mn Mo Mt N Na Nb Nd '
            'Ne Nh Ni No Np O Og Os P Pa Pb Pd Pm Po Pr Pt Pu Ra Rb Re Rf Rg Rh Rn Ru S Sb Sc Se Sg Si Sm '
            'Sn Sr Ta Tb Tc Te Th Ti Tl Tm Ts U V W Xe Y Yb Zn Zr').split()
# Require complete bounded tokens composed of genuine element symbols. Normal
# words, material identifiers, priorities and descriptor field names are not formulas.
ATOM = '(?:' + '|'.join(sorted(ELEMENTS, key=len, reverse=True)) + r')(?:\d+(?:\.\d+)?)?'
FORMULA = re.compile(r'(?<![A-Za-z0-9])(?:' + ATOM + r'){2,}(?![A-Za-z0-9])')
# These ordinary report abbreviations happen to resemble elemental tokens.
# Explicit formula/code contexts and exact private notation remain protected.
ORDINARY_ABBREVIATIONS = {'FF', 'IDs', 'IP'}
VECTOR_LITERAL = re.compile(r'\b(?:' + '|'.join(DESCRIPTOR_FIELDS) + r')\b\s*[:=]\s*[-+]?\d', re.I)
GRAPH_LITERAL = re.compile(r'<\s*(?:svg|img|image)\b|data\s*:\s*image/|\b(?:bond|atom)[-_]\d+\b', re.I)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value, allow_empty=False):
    return isinstance(value, list) and (allow_empty or bool(value)) and all(text(x) for x in value) and len(value) == len(set(value))


def stamp(value):
    return _privacy.time(value)


def values_and_fields(value, path='annex'):
    """Traverse annotation strings and keys only, never emit underlying values."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield ('key', str(key), path + '.' + str(key))
            yield from values_and_fields(child, path + '.' + str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from values_and_fields(child, path + f'[{index}]')
    elif isinstance(value, str):
        yield ('text', value, path)


def aliases_in_experiment(experiment):
    aliases = set()
    for step in experiment.get('steps', []):
        selections = list(step.get('materials', []))
        for execution in step.get('executions', []):
            selections += execution.get('materialSelections', [])
        aliases.update((x.get('material') or {}).get('materialAlias') or (x.get('material') or {}).get('id') for x in selections)
    return aliases - {None}


def _validate(review, snapshot, sources, snapshot_name):
    errors = []
    def fail(code, path):
        errors.append({'code': code, 'path': path})
    if not isinstance(review, dict) or review.get('schemaVersion') != 1 or review.get('classification') != CLASSIFICATION:
        fail('INVALID_PRIVATE_ANNEX_CLASSIFICATION', 'annex')
    if review.get('publicationStatus') != 'PRIVATE_FUTURE_WORKFLOW_INPUT_ONLY_NOT_PUBLISHED':
        fail('ANNEX_IS_NOT_PRIVATE_WORKFLOW_INPUT', 'publicationStatus')
    if snapshot.get('readOnly') is not True or snapshot.get('truncated') is not False:
        fail('ANNEX_SNAPSHOT_NOT_VERIFIED_READONLY', 'snapshot')
    try:
        if stamp(review.get('snapshotAt')) != stamp(snapshot.get('snapshotAt')):
            fail('ANNEX_SNAPSHOT_DATE_MISMATCH', 'snapshotAt')
        if stamp(review.get('reviewedAt')) < stamp(snapshot.get('snapshotAt')):
            fail('ANNEX_REVIEW_PREDATES_SNAPSHOT', 'reviewedAt')
    except (ValueError, TypeError):
        fail('INVALID_ANNEX_DATE', 'dates')
    if not text(review.get('scope')) or not strings(review.get('limitations')):
        fail('MISSING_ANNEX_SCOPE_LIMITATIONS', 'scope')
    inputs = review.get('inputs')
    input_names = set()
    if not isinstance(inputs, list) or not inputs:
        fail('MISSING_HASH_BOUND_INPUTS', 'inputs')
        inputs = []
    for index, item in enumerate(inputs):
        path = f'inputs[{index}]'
        if not isinstance(item, dict) or set(item) != {'file', 'sha256'} or not text(item.get('file')):
            fail('INVALID_INPUT_REFERENCE', path)
            continue
        name = item['file']
        if Path(name).name != name or name in input_names:
            fail('DUPLICATE_OR_ESCAPING_INPUT_REFERENCE', path)
        input_names.add(name)
        if not isinstance(item.get('sha256'), str) or not SHA.fullmatch(item['sha256']):
            fail('INVALID_INPUT_HASH', path)
        elif name not in sources or sources[name]['sha256'] != item['sha256']:
            fail('INPUT_HASH_REFERENCE_MISMATCH', path)
    if snapshot_name not in input_names or sources.get(snapshot_name, {}).get('document') != snapshot:
        fail('SNAPSHOT_INPUT_NOT_BOUND', 'inputs')
    descriptors = [value['document'] for name, value in sources.items() if name in input_names
                   and isinstance(value.get('document'), dict)
                   and value['document'].get('classification') == 'PRIVATE_CHEMISTRY_DESCRIPTORS_DO_NOT_PUBLISH']
    descriptor_map = {}
    if len(descriptors) != 1:
        fail('MISSING_UNIQUE_PRIVATE_DESCRIPTOR_SOURCE', 'inputs')
    else:
        try:
            if stamp(descriptors[0].get('snapshotAt')) != stamp(snapshot.get('snapshotAt')):
                fail('DESCRIPTOR_SOURCE_SNAPSHOT_DATE_MISMATCH', 'inputs')
        except (ValueError, TypeError):
            fail('INVALID_DESCRIPTOR_SOURCE_DATE', 'inputs')
        for material in descriptors[0].get('materials', []):
            alias = material.get('materialAlias')
            if alias in descriptor_map:
                fail('DUPLICATE_DESCRIPTOR_MATERIAL_ALIAS', 'inputs')
            descriptor_map[alias] = material
    definitions = {m.get('materialAlias') or m.get('id'): m for m in snapshot.get('privateChemistryDefinitions', [])}
    experiments = {e['code']: e for e in snapshot.get('experimentSummaries', [])}
    all_material_aliases = set(definitions)
    for experiment in experiments.values():
        all_material_aliases |= aliases_in_experiment(experiment)
    library = review.get('sourceLibrary')
    if not isinstance(library, dict) or not library:
        fail('MISSING_PUBLIC_SOURCE_LIBRARY', 'sourceLibrary')
        library = {}
    for identifier, url in library.items():
        if not text(identifier) or not _privacy.public_https(url):
            fail('INVALID_PUBLIC_LITERATURE_SOURCE', 'sourceLibrary')
    cases = review.get('materialCases')
    if not isinstance(cases, list) or not cases:
        fail('MISSING_MATERIAL_MECHANISM_CASES', 'materialCases')
        cases = []
    ids, supported_aliases = set(), set()
    graph_cases = blocked_cases = unlinked_current_associations = 0
    for index, case in enumerate(cases):
        path = f'materialCases[{index}]'
        if not isinstance(case, dict):
            fail('INVALID_MATERIAL_CASE', path)
            continue
        identifier = case.get('id')
        if not text(identifier) or identifier in ids:
            fail('MISSING_OR_DUPLICATE_CASE_ID', path + '.id')
        ids.add(identifier)
        # The existing annex uses reviewed prose priorities. The public report
        # separately gates its P0/P1/P2 structured action envelope.
        if not text(case.get('materialName')) or not text(case.get('priority')):
            fail('MISSING_CASE_IDENTITY_OR_PRIORITY', path)
        evidence = case.get('materialEvidence')
        if not isinstance(evidence, dict):
            fail('MISSING_MATERIAL_EVIDENCE', path)
            evidence = {}
        if evidence.get('historicalLotVerified') is not False or case.get('historicalIdentityAndMolecularCausalityConfirmed') not in (None, False):
            fail('FALSE_VERIFIED_HISTORICAL_LOT_OR_CAUSALITY', path)
        if evidence.get('descriptorValuesAndGraphOmitted') is not True or case.get('fullStructureAndDescriptorVectorOmitted') is not True:
            fail('MISSING_EXPLICIT_GRAPH_VECTOR_OMISSION', path)
        exp_ids = case.get('experimentEvidenceIds')
        if not strings(exp_ids) or not set(exp_ids).issubset(experiments):
            fail('UNKNOWN_OR_MISSING_EXPERIMENT_EVIDENCE', path)
            exp_ids = []
        controls = case.get('discriminatingControls')
        if not strings(controls):
            fail('MISSING_DISCRIMINATING_CONTROLS', path)
        criteria = case.get('decisionCriteria')
        if not strings(criteria) and not text(case.get('decisionCriterion')):
            fail('MISSING_EXPLICIT_DECISION_CRITERIA', path)
        alternatives = case.get('competingExplanations', case.get('alternatives'))
        if not strings(alternatives):
            fail('MISSING_COMPETING_CAUSES', path)
        refs = case.get('literatureSourceIds')
        if not strings(refs) or not set(refs).issubset(library):
            fail('UNKNOWN_OR_MISSING_LITERATURE_SOURCE_IDS', path)
        recipe_evidence = case.get('recipeAndSolventEvidence')
        if not isinstance(recipe_evidence, list) or not recipe_evidence:
            fail('MISSING_RECIPE_SOLVENT_BOUNDARY', path)
            recipe_evidence = []
        covered_exps = set()
        for ri, recorded in enumerate(recipe_evidence):
            rpath = path + f'.recipeAndSolventEvidence[{ri}]'
            code = recorded.get('experimentCode')
            if code not in exp_ids or code in covered_exps:
                fail('RECIPE_CONTEXT_NOT_BOUND_TO_CASE', rpath)
                continue
            covered_exps.add(code)
            experiment = experiments[code]
            recipes = {s['recipe'].get('recipeAlias'): s['recipe'] for s in experiment.get('steps', []) if s.get('recipe')}
            actuals_present = any(s.get('executions') for s in experiment.get('steps', []))
            if recorded.get('currentRecipeObjectPresent') is not bool(recipes) or recorded.get('actualCapturesPresent') is not actuals_present:
                fail('RECIPE_ACTUAL_PRESENCE_MISMATCH', rpath)
            if recorded.get('actualRecipeOrSAMSolventHistoricalIdentityVerified') is not False:
                fail('FALSE_VERIFIED_ACTUAL_RECIPE_OR_SOLVENT', rpath)
            if not text(recorded.get('SAMCarrierContext')) or not text(recorded.get('boundary')):
                fail('MISSING_PLANNED_ACTUAL_SOLVENT_LIMITATION', rpath)
            contexts = recorded.get('currentRecipeContexts')
            if not isinstance(contexts, list):
                fail('MISSING_CURRENT_RECIPE_CONTEXTS', rpath)
                contexts = []
            recipe_aliases = set()
            for record in contexts:
                alias = record.get('recipeAlias')
                if alias not in recipes or alias in recipe_aliases:
                    fail('UNVERIFIED_OR_DUPLICATE_CURRENT_RECIPE_ALIAS', rpath)
                    continue
                recipe_aliases.add(alias)
                if record.get('historicalActualCompositionVerified') is not False or record.get('formulaIngredientsRatiosConcentrationsOmitted') is not True:
                    fail('FALSE_HISTORICAL_RECIPE_OR_EXPOSED_FORMULATION', rpath)
                if not all(text(record.get(key)) for key in ('evidenceBasis', 'coarseAbsorberContext', 'solventRoleContext', 'ingredientLinkBasis')):
                    fail('MISSING_CURRENT_RECIPE_EVIDENCE_BOUNDARY', rpath)
            if recipe_aliases != set(recipes):
                fail('UNREPORTED_CURRENT_RECIPE_CONTEXT', rpath)
        if covered_exps != set(exp_ids):
            fail('INCOMPLETE_RECIPE_SOLVENT_CASE_COVERAGE', path)
        status = case.get('status')
        if status == GRAPH_STATUS:
            graph_cases += 1
            alias = evidence.get('materialAlias')
            definition = definitions.get(alias)
            chemistry = (definition or {}).get('chemistry') or {}
            input_text = (definition or {}).get('smiles')
            correct_hash = hashlib.sha256(input_text.encode()).hexdigest() if isinstance(input_text, str) else None
            if (snapshot.get('chemistryAccessAvailable') is not True or not definition
                    or definition.get('validatedDefinition') is not True
                    or (definition.get('hashValidation') or {}).get('status') != 'MATCH'
                    or not text(chemistry.get('canonicalSmiles'))
                    or chemistry.get('inputSha256') != correct_hash):
                fail('GRAPH_CASE_HAS_NO_CURRENT_HASH_VALID_ALIAS', path)
            else:
                supported_aliases.add(alias)
                if case.get('materialName') != definition.get('name'):
                    fail('GRAPH_CASE_NAME_ALIAS_SUBSTITUTION', path)
                if (evidence.get('definitionStatus') != 'VALIDATED_CURRENT_GRAPH_NOT_HISTORICAL_LOT_PROOF'
                        or evidence.get('inputHashStatus') != 'MATCH' or evidence.get('inputSha256') != correct_hash
                        or evidence.get('definitionVersion') != chemistry.get('version')
                        or evidence.get('localEngineVersion') != chemistry.get('engineVersion')):
                    fail('GRAPH_DEFINITION_EVIDENCE_METADATA_MISMATCH', path)
                try:
                    if stamp(evidence.get('definitionGeneratedAt')) != stamp(chemistry.get('generatedAt')):
                        fail('GRAPH_DEFINITION_DATE_MISMATCH', path)
                except (ValueError, TypeError):
                    fail('INVALID_GRAPH_DEFINITION_DATE', path)
            descriptor = descriptor_map.get(alias) or {}
            consulted = evidence.get('privateDescriptorFieldsConsulted')
            matchers = evidence.get('privateMotifMatchersConsulted')
            if (descriptor.get('status') != 'VALIDATED_CURRENT_GRAPH' or not strings(consulted)
                    or descriptor.get('name') != (definition or {}).get('name')
                    or descriptor.get('definitionVersion') != chemistry.get('version')
                    or descriptor.get('historicalLotVerified') is not False
                    or not set(consulted).issubset(descriptor.get('descriptors', {}))
                    or not strings(matchers, allow_empty=True)
                    or not set(matchers).issubset(descriptor.get('motifCounts', {}))):
                fail('UNVERIFIED_PRIVATE_DESCRIPTOR_CONSULTATION', path)
            try:
                if stamp(descriptor.get('generatedAt')) != stamp(chemistry.get('generatedAt')):
                    fail('DESCRIPTOR_SOURCE_DEFINITION_DATE_MISMATCH', path)
            except (ValueError, TypeError):
                fail('INVALID_DESCRIPTOR_SOURCE_DEFINITION_DATE', path)
            for key in ('privateGraphToMechanismInterpretation', 'chemistryToRecipeCompatibility'):
                if not strings(case.get(key)):
                    fail('MISSING_CONDITIONAL_GRAPH_MECHANISM_REASONING', path + '.' + key)
            if not text(case.get('localOutcome')) or not text(case.get('reportSafeFutureSentence')):
                fail('MISSING_LOCAL_OUTCOME_OR_SAFE_INTERPRETATION', path)
            unlinked_current_associations += sum(alias not in aliases_in_experiment(experiments[code]) for code in exp_ids)
        elif status == BLOCKED_STATUS:
            blocked_cases += 1
            if (evidence.get('definitionStatus') != 'MISSING_FOR_CASE_IDENTITY'
                    or case.get('candidateMappingStatus') != 'NOT_CONFIRMED_DO_NOT_SUBSTITUTE'
                    or not text(case.get('reason'))
                    or not (strings(case.get('allowedCurrentReasoning')) or text(case.get('allowedCurrentReasoning')))):
                fail('MISSING_IDENTITY_BLOCK_NOT_EXPLICIT', path)
            recorded = case.get('recordedCaseAliases')
            alternate = case.get('candidateAlternateAliases')
            if not strings(recorded, allow_empty=True) or not set(recorded).issubset(all_material_aliases) or not strings(alternate, allow_empty=True) or not set(alternate).issubset(all_material_aliases):
                fail('UNVERIFIED_RECORDED_OR_CANDIDATE_ALIAS', path)
            if any(key in case for key in ('privateGraphToMechanismInterpretation', 'chemistryToRecipeCompatibility')):
                fail('MISSING_IDENTITY_CASE_CONTAINS_MOLECULE_SPECIFIC_REASONING', path)
        else:
            fail('UNSUPPORTED_MATERIAL_CASE_STATUS', path)
    if review.get('graphSupportedExactCaseMaterials') != len(supported_aliases):
        fail('GRAPH_SUPPORTED_UNIQUE_ALIAS_COUNT_MISMATCH', 'graphSupportedExactCaseMaterials')
    annotations = []
    for kind, value, path in values_and_fields(review):
        if kind == 'key':
            normalized = re.sub(r'[^a-z]', '', value.lower())
            if normalized in FORBIDDEN_KEYS or value in DESCRIPTOR_FIELDS:
                fail('RAW_GRAPH_FORMULA_OR_DESCRIPTOR_PAYLOAD_KEY', path)
        else:
            annotations.append(value)
            clean = _privacy.decoded(value)
            if GRAPH_LITERAL.search(clean) or VECTOR_LITERAL.search(clean):
                fail('GRAPH_OR_DESCRIPTOR_VECTOR_LITERAL', path)
            # Identity/priority/field-name metadata is not a molecular formula.
            if not path.endswith(('.id', '.materialName', '.priority', '.materialAlias', '.inputSha256')) and not any(label in path for label in ('inputs[', 'sourceLibrary.', 'privateDescriptorFieldsConsulted[', 'privateMotifMatchersConsulted[', 'experimentEvidenceIds[', 'recordedCaseAliases[', 'candidateAlternateAliases[')):
                matches = list(FORMULA.finditer(clean))
                explicit = _privacy.molecular_context_values(clean)
                if any(m.group() not in ORDINARY_ABBREVIATIONS for m in matches) or any(FORMULA.search(v) for v in explicit):
                    fail('MOLECULAR_FORMULA_LITERAL', path)
    leak = _privacy.private_leak(annotations, snapshot)
    if leak['longNotationMatches'] or leak['shortNotationMatches']:
        fail('PRIVATE_GRAPH_NOTATION_COPIED_INTO_ANNEX', 'annotationContent')
    return {'passed': not errors, 'gateVersion': 1, 'errors': errors,
            'counts': {'materialCases': len(cases), 'graphCaseRecords': graph_cases,
                       'uniqueHashValidGraphAliases': len(supported_aliases), 'blockedIdentityCases': blocked_cases,
                       'hashBoundInputs': len(input_names), 'unverifiedHistoricalExperimentMaterialAssociations': unlinked_current_associations},
            'scienceCertified': False,
            'limitations': ['Current graph support does not verify an older supplied lot, experimental composition, recipe solvent, or molecular cause.',
                            'Name-only association with older experiments remains hypothetical; the gate checks exact current aliases, not retrospective material identity.',
                            'Hash/privacy/contract validation does not certify physicochemical reasoning or literature transfer.']}


def validate(review, snapshot, sources, snapshot_name='snapshot.json'):
    try:
        return _validate(review, snapshot, sources, snapshot_name)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, RecursionError):
        return {'passed': False, 'gateVersion': 1, 'errors': [{'code': 'INVALID_NESTED_ANNEX_INPUT_SHAPE', 'path': 'inputs'}],
                'counts': {}, 'scienceCertified': False}


def load_private(path):
    if stat.S_IMODE(path.stat().st_mode) != 0o600 or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError('INPUT_NOT_PRIVATE_OR_SIZE_BOUND_EXCEEDED')
    data = path.read_bytes()
    return json.loads(data), hashlib.sha256(data).hexdigest()


def validate_files(review_path, snapshot_path):
    try:
        parent = review_path.parent.resolve(strict=True)
        if (review_path.resolve(strict=True).parent != parent
                or snapshot_path.resolve(strict=True).parent != parent):
            raise ValueError('ANNEX_OR_SNAPSHOT_ESCAPES_RUN_DIRECTORY')
        review, _ = load_private(review_path)
        snapshot, _ = load_private(snapshot_path)
        sources = {}
        for item in review.get('inputs', []):
            name = item.get('file')
            if not text(name) or Path(name).name != name:
                raise ValueError('ESCAPING_ANNEX_INPUT_REFERENCE')
            source = (parent / name).resolve(strict=True)
            if source.parent != parent:
                raise ValueError('ESCAPING_ANNEX_INPUT_REFERENCE')
            document, digest = load_private(source)
            sources[name] = {'document': document, 'sha256': digest}
        if snapshot_path.resolve(strict=True) != (parent / snapshot_path.name).resolve(strict=True):
            raise ValueError('SNAPSHOT_PATH_REFERENCE_MISMATCH')
        return validate(review, snapshot, sources, snapshot_path.name)
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return {'passed': False, 'gateVersion': 1, 'errors': [{'code': 'PRIVATE_ANNEX_INPUT_READ_OR_SCOPE_FAILED', 'path': 'inputs'}],
                'counts': {}, 'scienceCertified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('annex', type=Path)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = validate_files(args.annex, args.snapshot)
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
