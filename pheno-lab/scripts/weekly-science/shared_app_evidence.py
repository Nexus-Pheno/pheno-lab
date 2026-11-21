#!/usr/bin/env python3
"""Validate private app-derived evidence without recalculating device statistics.

The application owns selection, arithmetic and source hashing. Legacy scan-median
cohorts remain independently audited secondary evidence, never silently rewritten.
"""
import copy
import datetime as dt
import re

METHOD_VERSION = 'pheno-device-evidence-2026-10-28'
POLICY_VERSION = 'accepted-device-result-v1'
SELECTION_SCOPE = 'EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT'
HASH = re.compile(r'[0-9a-f]{64}\Z')


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Evidence date is required')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.utcoffset() is None:
        raise ValueError('Evidence date requires a timezone')
    return parsed


def selected_experiment_codes(snapshot):
    """Current measured/changed contexts, not every historical imported record."""
    codes = {row.get('experimentCode') for row in snapshot.get('sampleMeasurements', [])
             if row.get('isPeriodEvidence') is True or row.get('measuredInPeriod') is True}
    codes.update(exp.get('code') for exp in snapshot.get('experimentSummaries', [])
                 if exp.get('newInPeriod') is True or exp.get('updatedInPeriod') is True)
    return sorted(code for code in codes if isinstance(code, str) and code)


def validate_export(value, snapshot, requested_codes=None):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or value.get('readOnly') is not True:
        raise ValueError('App evidence is not a complete read-only export')
    if value.get('methodVersion') != METHOD_VERSION or value.get('selectionScope') != SELECTION_SCOPE:
        raise ValueError('Unsupported shared app evidence method or population')
    if timestamp(value.get('sourceSnapshotAt')) != timestamp(snapshot.get('snapshotAt')):
        raise ValueError('App evidence is not bound to the frozen source snapshot')
    if timestamp(value.get('reportWindowEnd')) != timestamp(snapshot.get('windowEnd')):
        raise ValueError('App evidence reporting cutoff differs from the source snapshot')
    if not timestamp(snapshot.get('windowEnd')) <= timestamp(snapshot.get('snapshotAt')) <= timestamp(value.get('asOf')):
        raise ValueError('Shared evidence dates are not ordered')
    experiments = value.get('experiments')
    if not isinstance(experiments, list) or len(experiments) > 250:
        raise ValueError('App evidence experiment bound exceeded')
    source_codes = {exp.get('code') for exp in snapshot.get('experimentSummaries', [])}
    found = set()
    for item in experiments:
        if not isinstance(item, dict) or item.get('experimentCode') in found or item.get('experimentCode') not in source_codes:
            raise ValueError('Unknown or repeated app evidence experiment')
        found.add(item['experimentCode'])
        evidence = item.get('evidence')
        if (not isinstance(evidence, dict) or evidence.get('schemaVersion') != 1
                or evidence.get('policyVersion') != POLICY_VERSION
                or evidence.get('screeningReferencePcePoints') != 0.5
                or evidence.get('criterionStatus') != 'EXPLORATORY_INTERNAL_REFERENCE_NOT_CONFIRMATION'
                or not HASH.fullmatch(evidence.get('sourceHash', ''))
                or (evidence.get('experiment') or {}).get('code') != item['experimentCode']
                or not isinstance(evidence.get('characterizations'), list)):
            raise ValueError('Invalid app evidence source binding or selection policy')
        ai = item.get('aiInterpretation')
        if not isinstance(ai, dict) or not isinstance(ai.get('sourceHashMatches'), bool):
            raise ValueError('AI interpretation has no current source binding')
        summary = ai.get('summary')
        # A stale summary is retained as private history, never upgraded by the collector.
        current_interpretation_hash = ai.get('currentInterpretationSourceHash') or evidence['sourceHash']
        if ai['sourceHashMatches'] and (not isinstance(summary, dict) or summary.get('sourceHash') != current_interpretation_hash):
            raise ValueError('AI interpretation incorrectly marked current')
        versions = ai.get('expectedVersions')
        if (not isinstance(ai.get('versionCurrent'), bool) or not isinstance(versions, dict)
                or versions.get('policyVersion') != evidence['policyVersion']
                or not all(isinstance(versions.get(key), str) and versions[key]
                           for key in ('ruleVersion', 'promptVersion'))):
            raise ValueError('AI interpretation version policy is missing')
        if ai['versionCurrent'] and (not isinstance(summary, dict) or any(
                summary.get(key) != versions[key] for key in ('policyVersion', 'ruleVersion', 'promptVersion'))):
            raise ValueError('AI interpretation incorrectly marked version-current')
    if requested_codes is not None and found != set(requested_codes):
        raise ValueError('Requested app evidence coverage is incomplete')
    return value


def dossier_primary_evidence(snapshot):
    export = snapshot.get('sharedAppEvidence')
    if export is None:
        return None  # Historical immutable snapshots keep their original estimand.
    export = validate_export(export, snapshot)
    return {'methodVersion': METHOD_VERSION, 'policyVersion': POLICY_VERSION,
            'selectionScope': SELECTION_SCOPE, 'asOf': export['asOf'],
            'sourceSnapshotAt': export['sourceSnapshotAt'],
            'reportWindowEnd': export['reportWindowEnd'],
            'experiments': copy.deepcopy(export['experiments']),
            'comparisonRule': {'championPceGainPercentagePoints': 0.5,
                               'status': 'EXPLORATORY_PHENO_SCREENING_REFERENCE_NOT_CONFIRMATION',
                               'lowerChampionGainIsNotAutomaticRejection': True},
            'secondaryAnalysis': 'LEGACY_SOURCE_BOUND_SCAN_MEDIANS_AND_PROTOCOL_PERIOD_PANELS',
            'limits': ['Current accepted device results are cumulative at asOf, not newly fabricated seven-day outcomes.',
                       'Compare app, AI and weekly values only at the same policy, cutoff and device population.',
                       'A matching source hash is not researcher approval or independent experimental evidence.',
                       'Historical reports and scan-median cohorts retain their saved method and source hashes.']}
