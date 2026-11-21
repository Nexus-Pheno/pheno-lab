#!/usr/bin/env python3
"""Fail-closed experiment decision contract, supplementary to the academic gate.

Usage: validate_decision_report.py DOCUMENT SNAPSHOT DOSSIER
       [--prior-ledger VERIFIED_PRIOR_DOSSIER] [--output PRIVATE_GATE]

The private decisionReview envelope is never rendered. This checks source binding,
coverage and declared review; it does not certify an LLM's scientific judgments.
No word count, theory length or arbitrary case count measures report quality.
"""
import argparse
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics
import sys

BASE = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, BASE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


public = load('decision_public_gate', 'validate_rd_document.py')
analysis = load('decision_analysis', 'analyze_rd_snapshot.py')
PERIODS = {'CURRENT_PERIOD', 'PREVIOUS_EQUAL_DURATION_PERIOD', 'EARLIER_HISTORY'}
VIEWS = {'STRICT_RECORDED_PROTOCOL', 'TRACE_NAME_EXCLUDED_LIMITED_PROTOCOL'}
STAT_DEFINITIONS = {
    'championScanPce': 'MAX_INFERENCE_ELIGIBLE_RECORDED_SCAN_PCE',
    'bestPhysicalSampleMedianPce': 'MAX_PHYSICAL_SAMPLE_MEDIAN_PCE',
    'meanSampleMedianPce': 'ARITHMETIC_MEAN_PHYSICAL_SAMPLE_MEDIANS',
    'medianSampleMedianPce': 'MEDIAN_PHYSICAL_SAMPLE_MEDIANS',
    'sdSampleMedianPce': 'SAMPLE_SD_PHYSICAL_SAMPLE_MEDIANS_DDOF_1',
    'iqrSampleMedianPce': 'LINEAR_INTERPOLATED_Q3_MINUS_Q1_PHYSICAL_SAMPLE_MEDIANS',
}
PEER_CHECKS = {'sourceBoundProjectStatistics', 'populationComparability',
               'recordedDesignInputsAndTemporalLimits', 'objectiveAttainment',
               'rankedCausesAndCounterevidence', 'controlsAndDiscriminatingSignatures',
               'proposedCriteriaAndOutcomeBranches', 'priorIssueContinuity',
               'noAssumedExecution', 'bilingualDecisionEquivalence', 'decisionsVisibleInBothLanguages'}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value, empty=False):
    return public.unique_strings(value, allow_empty=empty)


def bilingual(item, key):
    return isinstance(item, dict) and text(item.get(key + 'En')) and text(item.get(key + 'Zh'))


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def payload_digest(value):
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')))


def finite(value):
    return analysis.finite(value)


def same_number(first, second):
    if first is None or second is None:
        return first is None and second is None
    return finite(first) and finite(second) and math.isclose(first, second, rel_tol=1e-10, abs_tol=1e-9)


def normalized(value):
    return ' '.join(public.decoded(value).split()).casefold()


def source_statistics(rows):
    """Champion is explicitly a scan; averages/dispersion use sample medians."""
    samples = defaultdict(list)
    for row in rows:
        samples[row['sampleAlias']].append(row['metrics']['pce'])
    values = [statistics.median(scans) for scans in samples.values()]
    summary = analysis.describe(values)
    return {'nScans': len(rows), 'nSamples': len(values),
            'championScanPce': max((row['metrics']['pce'] for row in rows), default=None),
            'bestPhysicalSampleMedianPce': max(values, default=None),
            'meanSampleMedianPce': statistics.mean(values) if values else None,
            'medianSampleMedianPce': summary['median'],
            'sdSampleMedianPce': summary['sampleStandardDeviation'],
            'iqrSampleMedianPce': summary['iqr']}


def _validate(document, snapshot, dossier, prior_ledger):
    original = public.validate(document, snapshot, dossier)
    errors = [{'code': 'PUBLIC_GATE_' + e['code'], 'path': e['path']} for e in original['errors']]

    def fail(code, path):
        errors.append({'code': code, 'path': path})

    review = document.get('decisionReview')
    if not isinstance(review, dict) or type(review.get('schemaVersion')) is not int or review.get('schemaVersion') != 1:
        fail('MISSING_DECISION_REVIEW', 'decisionReview')
        review = {}
    if not text(review.get('preparedBy')):
        fail('MISSING_DECISION_AUTHOR', 'decisionReview.preparedBy')
    if review.get('statisticsDefinitions') != STAT_DEFINITIONS or review.get('pceUnit') != '%':
        fail('UNDEFINED_OR_CHANGED_STATISTICAL_ESTIMANDS', 'decisionReview.statisticsDefinitions')
    if review.get('expectationPolicy') != 'LLM_PROPOSALS_IN_REPORT_NOT_RECORDED_EXPERIMENT_FIELDS':
        fail('EXPECTATIONS_NOT_EXPLICIT_REPORT_PROPOSALS', 'decisionReview.expectationPolicy')
    if review.get('enforceVisibleDecisions') is not True:
        fail('VISIBLE_BILINGUAL_DECISIONS_NOT_ENFORCED', 'decisionReview.enforceVisibleDecisions')
    sections = {s.get('id') for s in document.get('sections', []) if isinstance(s, dict)}
    visible_sections = {s.get('id'): {lang: normalized(public.html_plain(s.get('body' + lang, ''))[0])
                                    for lang in ('En', 'Zh')}
                        for s in document.get('sections', []) if isinstance(s, dict)}

    def visible(item, fields, section_id, path):
        """Match reviewed interpretations, never raw narratives/hashes/graphs."""
        for field in fields:
            for lang in ('En', 'Zh'):
                value = item.get(field + lang)
                if not text(value):
                    continue  # Required field checks report the shape failure.
                plain = normalized(public.html_plain(value)[0])
                if not plain or plain not in visible_sections.get(section_id, {}).get(lang, ''):
                    fail('DECISION_NOT_VISIBLE_IN_LINKED_PUBLIC_SECTION', path + '.' + field + lang)

    known = public.evidence_ids(snapshot, dossier)
    experiments = {e['code']: e for e in snapshot.get('experimentSummaries', [])}
    evidence_to_experiments = {code: {code} for code in experiments}
    unique, _ = analysis.unique_measurements(snapshot)
    measurements = {row['measurementAlias']: row for _, row in unique if text(row.get('measurementAlias'))}
    for alias, row in measurements.items():
        evidence_to_experiments[alias] = {row.get('experimentCode')} & set(experiments)
    recomputed = analysis.analyze(snapshot)
    project_sources = {p.get('projectKey') or public.project_alias(p.get('projectAlias')): p
                       for p in recomputed.get('projects', [])}
    declared_project_sources = {p.get('projectKey') or public.project_alias(p.get('projectAlias')): p
                                for p in dossier.get('projects', [])}
    if set(project_sources) != set(declared_project_sources) or any(
            project.get('periodPerformance') != declared_project_sources.get(alias, {}).get('periodPerformance')
            for alias, project in project_sources.items()):
        fail('DOSSIER_PERIOD_PERFORMANCE_DOES_NOT_RECONCILE_TO_SOURCE_PARTITION', 'dossier.projects')
    for project in dossier.get('projects', []):
        for stratum in project.get('strata', []):
            evidence_to_experiments[stratum.get('stratumId')] = {stratum.get('experimentCode')} & set(experiments)

    def refs(values, path, empty=False):
        if not strings(values, empty=empty) or not set(values).issubset(known):
            fail('UNKNOWN_OR_MISSING_DECISION_EVIDENCE', path)
            return []
        return values

    all_ids = set()

    def identity(item, path):
        identifier = item.get('id')
        if not text(identifier) or not public.IDENTIFIER.fullmatch(identifier):
            fail('INVALID_DECISION_ITEM_ID', path + '.id')
        elif identifier in all_ids:
            fail('DUPLICATE_DECISION_ITEM_ID', path + '.id')
        else:
            all_ids.add(identifier)
        if item.get('sectionId') not in sections:
            fail('DECISION_NOT_LINKED_TO_REPORT_SECTION', path + '.sectionId')

    def experiment_codes(values, path, empty=False):
        if not strings(values, empty=empty) or not set(values).issubset(experiments):
            fail('UNKNOWN_OR_MISSING_EXPERIMENT_CODES', path)
            return []
        return values

    required_projects = {public.project_alias(p.get('projectAlias')) for p in snapshot.get('projectInventory', [])} | {'UNASSIGNED'}
    frozen_end = public.time(snapshot.get('windowEnd'))
    frozen_period = public.time(snapshot.get('periodStart') or (frozen_end - dt.timedelta(days=7)).isoformat())
    frozen_history = public.time(snapshot.get('historyStart') or (frozen_end - dt.timedelta(days=90)).isoformat())
    expected_windows = analysis.period_performance([], frozen_period, frozen_end, frozen_history)['windows']
    projects = review.get('projectReviews')
    if not isinstance(projects, list):
        projects = []
    if [p.get('projectAlias') for p in projects].count(None) or set(p.get('projectAlias') for p in projects) != required_projects or len(projects) != len(required_projects):
        fail('INCOMPLETE_PROJECT_DECISION_COVERAGE', 'decisionReview.projectReviews')
    required_experiments = set()
    comparison_count = 0
    cohort_count = 0
    for index, project in enumerate(projects):
        path = f'decisionReview.projectReviews[{index}]'
        if project.get('sectionId') not in sections:
            fail('PROJECT_REVIEW_NOT_LINKED_TO_REPORT', path)
        source = project_sources.get(project.get('projectAlias'), {})
        performance = source.get('periodPerformance')
        if not isinstance(performance, dict):
            fail('MISSING_SOURCE_BOUND_PERIOD_PERFORMANCE', path)
            performance = {}
        for label, expected_window in expected_windows.items():
            actual_window = (performance.get('windows') or {}).get(label, {})
            try:
                if any(public.time(actual_window.get(key)) != public.time(expected_window[key])
                       for key in ('start', 'end', 'availableSourceStart')) or any(
                           actual_window.get(key) is not expected_window[key] for key in ('nonempty', 'fullSourceCoverage')):
                    fail('PERIOD_WINDOWS_DO_NOT_MATCH_FROZEN_SNAPSHOT', path)
            except (ValueError, TypeError):
                fail('PERIOD_WINDOWS_DO_NOT_MATCH_FROZEN_SNAPSHOT', path)
        if project.get('analysisView') not in VIEWS:
            fail('UNKNOWN_PROJECT_COHORT_VIEW', path + '.analysisView')
        source_cohorts = {c['routeCohortId']: c for c in performance.get('routeCohorts', [])
                          if c.get('view') == project.get('analysisView')
                          and c.get('evidenceTier') == 'SOURCE_LINKED_INSTRUMENT_SCAN'
                          and (c.get('inferenceOutcomes') or {}).get('nScans', 0) > 0}
        periods = project.get('periods')
        if not isinstance(periods, list) or len(periods) != len(PERIODS) or {p.get('period') for p in periods} != PERIODS:
            fail('MISSING_CURRENT_PREVIOUS_HISTORY_COMPARISON', path + '.periods')
            periods = periods if isinstance(periods, list) else []
        declared_cohorts = set()
        declared_statistics = {}
        for pi, period in enumerate(periods):
            pp = path + f'.periods[{pi}]'
            label = period.get('period')
            window = (performance.get('windows') or {}).get(label, {})
            if not window or not bilingual(period, 'selectionReason'):
                fail('MISSING_PERIOD_SOURCE_WINDOW_OR_SELECTION_SCOPE', pp)
            cohorts = period.get('cohorts')
            if not isinstance(cohorts, list):
                fail('INVALID_PERIOD_COHORTS', pp)
                cohorts = []
            eligible = {cid for cid, c in source_cohorts.items() if c.get('periodCohort') == label}
            selected = [c.get('cohortId') for c in cohorts]
            if len(selected) != len(set(selected)) or not set(selected).issubset(eligible):
                fail('UNKNOWN_DUPLICATE_OR_WRONG_PERIOD_COHORT', pp)
            omitted = period.get('omittedCohortCount')
            if isinstance(omitted, bool) or not isinstance(omitted, int) or omitted != len(eligible - set(selected)):
                fail('HIDDEN_OR_INCORRECT_COHORT_OMISSION_COUNT', pp)
            expected_status = 'NO_ELIGIBLE_DATA' if not eligible else ('MIXED_COHORT_NO_SINGLE_MEAN' if len(eligible) > 1 else 'SOURCE_BOUND')
            if period.get('status') != expected_status:
                fail('PERIOD_STATUS_DOES_NOT_MATCH_SOURCE_COHORTS', pp)
            if 'statistics' in period:
                fail('POOLED_PROJECT_STATISTICS_NOT_ALLOWED', pp + '.statistics')
            for ci, cohort in enumerate(cohorts):
                cp = pp + f'.cohorts[{ci}]'
                bound = source_cohorts.get(cohort.get('cohortId'))
                if not bound:
                    continue
                declared_cohorts.add(cohort['cohortId'])
                cohort_count += 1
                aliases = bound.get('measurementAliases')
                if not strings(aliases) or not set(aliases).issubset(measurements):
                    fail('COHORT_LACKS_UNIQUE_SOURCE_MEASUREMENTS', cp)
                    continue
                rows = [measurements[alias] for alias in aliases]
                start, end = public.time(window['start']), public.time(window['end'])
                valid_rows = True
                for row in rows:
                    experiment = experiments.get(row.get('experimentCode'))
                    invalid = (not experiment or analysis.project_key(experiment) != project.get('projectAlias')
                               or experiment.get('qualityReview') or experiment.get('isTest')
                               or str(experiment.get('title', '')).lower().startswith('[test]')
                               or row.get('group') in {'ERROR', 'EXTRA'} or row.get('condition', 'LIGHT') != 'LIGHT'
                               or row.get('sourceLinked') is not True
                               or not text(row.get('sampleAlias')) or not finite((row.get('metrics') or {}).get('pce'))
                               or not 0 <= row['metrics']['pce'] <= 50
                               or not analysis.metric_diagnostics(row | {'metricUnits': row.get('metricUnits') or snapshot.get('metricUnits')})['performanceInferenceEligible'])
                    try:
                        invalid = invalid or not start <= public.time(row.get('measuredAt')) < end
                    except (ValueError, TypeError):
                        invalid = True
                    if invalid:
                        valid_rows = False
                if not valid_rows:
                    fail('COHORT_SOURCE_NOT_ELIGIBLE_OR_NOT_MEASURED_IN_PERIOD', cp)
                    continue
                expected = source_statistics(rows)
                declared_statistics[cohort['cohortId']] = expected
                stats = cohort.get('statistics')
                if not isinstance(stats, dict) or set(stats) != set(expected):
                    fail('MISSING_OR_UNKNOWN_COHORT_STATISTICS', cp + '.statistics')
                elif any(not same_number(stats[key], value) for key, value in expected.items()):
                    fail('COHORT_STATISTICS_DO_NOT_RECONCILE_TO_SOURCE', cp + '.statistics')
                if not bilingual(cohort, 'comparabilityLimits'):
                    fail('MISSING_COHORT_COMPARABILITY_LIMITS', cp)
                visible(cohort, ('comparabilityLimits',), project.get('sectionId'), cp)
                status = cohort.get('comparabilityStatus')
                issues = bound.get('comparabilityIssues') or []
                if status not in {'COMPARABLE', 'DESCRIPTIVE_ONLY'} or (status == 'COMPARABLE' and (issues or bound.get('view') != 'STRICT_RECORDED_PROTOCOL')):
                    fail('UNVERIFIED_COHORT_CANNOT_BE_CALLED_COMPARABLE', cp)
                batches = (bound.get('inferenceOutcomes') or {}).get('independentBatchCount')
                replication = cohort.get('batchReplicationStatus')
                if replication not in {'UNVERIFIED_INDEPENDENT_BATCHES', 'VERIFIED_BATCH_REPLICATION'} or (replication == 'VERIFIED_BATCH_REPLICATION' and (not isinstance(batches, int) or isinstance(batches, bool) or batches < 2)):
                    fail('REPEATABILITY_CLAIM_LACKS_VERIFIED_BATCHES', cp)
        judgment = project.get('longitudinalJudgment')
        if not isinstance(judgment, dict) or judgment.get('status') not in {'COMPARABLE_CHANGE', 'EXPLORATORY_CHANGE', 'INSUFFICIENT_COMPARABLE_DATA'} or not bilingual(judgment, 'analysis') or not bilingual(judgment, 'limits'):
            fail('MISSING_EXPLICIT_LONGITUDINAL_JUDGMENT', path + '.longitudinalJudgment')
            judgment = {}
        visible(judgment, ('analysis', 'limits'), project.get('sectionId'), path + '.longitudinalJudgment')
        pairs = judgment.get('pairs')
        if not isinstance(pairs, list) or (judgment.get('status') != 'INSUFFICIENT_COMPARABLE_DATA' and not pairs):
            fail('CHANGE_JUDGMENT_LACKS_MATCHED_PERIOD_PAIRS', path + '.longitudinalJudgment')
            pairs = pairs if isinstance(pairs, list) else []
        for pair in pairs:
            current = source_cohorts.get(pair.get('currentCohortId'), {})
            previous = source_cohorts.get(pair.get('referenceCohortId'), {})
            if (not current or not previous or current.get('periodCohort') != 'CURRENT_PERIOD'
                    or previous.get('periodCohort') not in PERIODS - {'CURRENT_PERIOD'}
                    or current.get('routeId') != previous.get('routeId')
                    or pair.get('currentCohortId') not in declared_cohorts or pair.get('referenceCohortId') not in declared_cohorts):
                fail('LONGITUDINAL_PAIR_NOT_SAME_ROUTE_ACROSS_PERIODS', path)
                continue
            if judgment.get('status') == 'COMPARABLE_CHANGE' and (current.get('comparabilityIssues') or previous.get('comparabilityIssues') or project.get('analysisView') != 'STRICT_RECORDED_PROTOCOL'):
                fail('LONGITUDINAL_CHANGE_IS_NOT_VERIFIED_COMPARABLE', path)
            reference_window = (performance.get('windows') or {}).get(previous.get('periodCohort'), {})
            if judgment.get('status') == 'COMPARABLE_CHANGE' and reference_window.get('fullSourceCoverage') is not True:
                fail('INCOMPLETE_REFERENCE_PERIOD_CANNOT_BE_CALLED_COMPARABLE', path)
            if not bilingual(pair, 'interpretation'):
                fail('PERIOD_COMPARISON_LACKS_INTERPRETATION', path)
            visible(pair, ('interpretation',), project.get('sectionId'), path + '.longitudinalJudgment.pairs')
            present_stats = declared_statistics.get(pair.get('currentCohortId'))
            reference_stats = declared_statistics.get(pair.get('referenceCohortId'))
            changes = pair.get('differencesCurrentMinusReference')
            if not isinstance(changes, dict) or set(changes) != set(STAT_DEFINITIONS):
                fail('MISSING_COMPONENTS_OF_LONGITUDINAL_PERFORMANCE_CHANGE', path)
            elif present_stats is not None and reference_stats is not None:
                for name in STAT_DEFINITIONS:
                    expected_change = (present_stats[name] - reference_stats[name]
                                       if finite(present_stats[name]) and finite(reference_stats[name]) else None)
                    if not same_number(changes[name], expected_change):
                        fail('LONGITUDINAL_CHANGE_DOES_NOT_RECONCILE_TO_SOURCE', path)
            comparison_count += 1
        routes = project.get('routeDecisions')
        has_data = bool(source_cohorts)
        if not isinstance(routes, list) or not routes:
            fail('MISSING_ROUTE_CONTINUE_ADJUST_HOLD_DECISION', path)
            routes = []
        for ri, route in enumerate(routes):
            rp = path + f'.routeDecisions[{ri}]'
            identity(route, rp)
            codes = experiment_codes(route.get('experimentCodes'), rp + '.experimentCodes', empty=not has_data)
            if any(analysis.project_key(experiments[code]) != project.get('projectAlias') for code in codes):
                fail('ROUTE_DECISION_REFERENCES_ANOTHER_PROJECT', rp)
            required_experiments.update(codes)
            if route.get('decision') not in {'CONTINUE', 'ADJUST', 'HOLD'} or not bilingual(route, 'reason') or route.get('confidence') not in {'LOW', 'MODERATE', 'HIGH'}:
                fail('INCOMPLETE_REVIEWED_ROUTE_DECISION', rp)
            visible(route, ('reason',), route.get('sectionId'), rp)
            refs(route.get('evidenceIds'), rp + '.evidenceIds', empty=not has_data)
            if not has_data and route.get('decision') != 'HOLD':
                fail('NO_ELIGIBLE_DATA_CANNOT_ESTABLISH_ROUTE_SUCCESS', rp)

    for case in (document.get('academicReview') or {}).get('coreCases', []):
        for evidence in case.get('evidenceIds', []):
            required_experiments.update(evidence_to_experiments.get(evidence, set()))
    selected = review.get('selectedExperiments')
    if not isinstance(selected, list) or not selected:
        fail('MISSING_EXPERIMENT_PURPOSE_REVIEW', 'decisionReview.selectedExperiments')
        selected = []
    selected_codes = [item.get('experimentCode') for item in selected]
    if len(selected_codes) != len(set(selected_codes)) or not set(selected_codes).issubset(experiments):
        fail('UNKNOWN_OR_DUPLICATE_SELECTED_EXPERIMENT', 'decisionReview.selectedExperiments')
    for index, item in enumerate(selected):
        path = f'decisionReview.selectedExperiments[{index}]'
        code = item.get('experimentCode')
        experiment = experiments.get(code, {})
        if item.get('sectionId') not in sections or item.get('temporalBasis') != 'CURRENT_AT_SNAPSHOT':
            fail('EXPERIMENT_REVIEW_LACKS_SECTION_OR_TEMPORAL_BASIS', path)
        if not bilingual(item, 'copiedOrRetrospectiveLimits'):
            fail('CURRENT_DESIGN_TEXT_MISTAKEN_FOR_PREREGISTRATION', path)
        visible(item, ('copiedOrRetrospectiveLimits',), item.get('sectionId'), path)
        inputs = item.get('recordedInputs')
        if not isinstance(inputs, dict) or set(inputs) != {'observation', 'problem', 'hypothesis'}:
            fail('MISSING_RECORDED_OBSERVATION_PROBLEM_HYPOTHESIS', path)
            inputs = {}
        for field in ('observation', 'problem', 'hypothesis'):
            binding = inputs.get(field, {})
            raw = experiment.get(field) or ''
            present = text(public.html_plain(raw)[0])
            if binding.get('sourceField') != field or binding.get('status') != ('SOURCE_RECORDED' if present else 'NOT_RECORDED'):
                fail('DESIGN_FIELD_STATUS_NOT_SOURCE_BOUND', path + '.recordedInputs.' + field)
            if present and binding.get('textSha256') != digest(raw):
                fail('DESIGN_FIELD_HASH_DOES_NOT_MATCH_SOURCE', path + '.recordedInputs.' + field)
            if not present and binding.get('textSha256') is not None:
                fail('MISSING_DESIGN_FIELD_HAS_INVENTED_SOURCE_HASH', path + '.recordedInputs.' + field)
            if not bilingual(binding, 'reviewerInterpretation'):
                fail('DESIGN_FIELD_NOT_INTERPRETED_BY_REVIEWER', path + '.recordedInputs.' + field)
            visible(binding, ('reviewerInterpretation',), item.get('sectionId'), path + '.recordedInputs.' + field)
        objective = item.get('objectiveAttainment')
        if not isinstance(objective, dict) or objective.get('status') not in {'ANSWERED', 'PARTIAL', 'UNRESOLVED', 'NO_PRESPECIFIED_GOAL'} or not bilingual(objective, 'analysis'):
            fail('MISSING_EXPERIMENT_OBJECTIVE_ATTAINMENT_JUDGMENT', path)
            objective = {}
        if objective.get('goalBasis') not in {'REVIEWER_INTERPRETATION_OF_CURRENT_FIELDS', 'NO_DOCUMENTED_GOAL'}:
            fail('EXPERIMENT_GOAL_HAS_NO_HONEST_RECORDED_BASIS', path)
        visible(objective, ('analysis',), item.get('sectionId'), path + '.objectiveAttainment')
        goal_recorded = any(text(public.html_plain(experiment.get(field) or '')[0]) for field in ('problem', 'hypothesis'))
        if objective.get('goalBasis') == 'NO_DOCUMENTED_GOAL' and objective.get('status') != 'NO_PRESPECIFIED_GOAL':
            fail('NO_RECORDED_GOAL_CANNOT_BE_DECLARED_ACHIEVED', path)
        if objective.get('goalBasis') == 'REVIEWER_INTERPRETATION_OF_CURRENT_FIELDS' and not goal_recorded:
            fail('OBJECTIVE_INTERPRETATION_HAS_NO_RECORDED_GOAL_TEXT', path)
        evidence = refs(objective.get('evidenceIds'), path + '.objectiveAttainment.evidenceIds', empty=objective.get('status') in {'UNRESOLVED', 'NO_PRESPECIFIED_GOAL'})
        if objective.get('status') in {'ANSWERED', 'PARTIAL'} and not any(code in evidence_to_experiments.get(ref, set()) and ref in measurements for ref in evidence):
            fail('OBJECTIVE_ANSWER_HAS_NO_LOCAL_MEASURED_EVIDENCE', path)

    causes = review.get('causeReviews')
    if not isinstance(causes, list) or not causes:
        fail('MISSING_EVIDENCE_RANKED_CAUSES', 'decisionReview.causeReviews')
        causes = []
    cause_ids = set()
    for index, cause in enumerate(causes):
        path = f'decisionReview.causeReviews[{index}]'
        identity(cause, path)
        cause_ids.add(cause.get('id'))
        codes = experiment_codes(cause.get('experimentCodes'), path + '.experimentCodes')
        required_experiments.update(codes)
        if cause.get('rankingStatus') not in {'BEST_SUPPORTED_TESTABLE', 'UNRESOLVED_COMPETING_CAUSES'} or cause.get('confidence') not in {'LOW', 'MODERATE', 'HIGH'} or not bilingual(cause, 'rankingReason'):
            fail('MISSING_CAUSE_RANKING_REASON_AND_UNCERTAINTY', path)
        visible(cause, ('rankingReason',), cause.get('sectionId'), path)
        mechanism_ids = set()
        for field in ('primaryCause', 'runnerUpCause'):
            mechanism = cause.get(field)
            if not isinstance(mechanism, dict) or not text(mechanism.get('id')) or mechanism.get('id') in mechanism_ids or not bilingual(mechanism, 'statement'):
                fail('MISSING_DISTINCT_PRIMARY_AND_RUNNER_UP_CAUSES', path + '.' + field)
                mechanism = mechanism if isinstance(mechanism, dict) else {}
            mechanism_ids.add(mechanism.get('id'))
            supports = refs(mechanism.get('supportingEvidenceIds'), path + '.' + field + '.supportingEvidenceIds')
            refs(mechanism.get('opposingEvidenceIds'), path + '.' + field + '.opposingEvidenceIds', empty=True)
            if not bilingual(mechanism, 'oppositionLimits'):
                fail('CAUSE_LACKS_COUNTEREVIDENCE_OR_MISSING_TEST_LIMITS', path + '.' + field)
            visible(mechanism, ('statement', 'oppositionLimits'), cause.get('sectionId'), path + '.' + field)
            if supports and not any(set(codes) & evidence_to_experiments.get(ref, set()) for ref in supports):
                fail('CAUSE_SUPPORT_HAS_NO_LINK_TO_SELECTED_EXPERIMENT', path + '.' + field)
        primary, runner_up = cause.get('primaryCause'), cause.get('runnerUpCause')
        if isinstance(primary, dict) and isinstance(runner_up, dict) and any(
                text(primary.get('statement' + lang)) and normalized(primary['statement' + lang]) == normalized(runner_up.get('statement' + lang, ''))
                for lang in ('En', 'Zh')):
            fail('SAME_STATEMENT_CANNOT_BE_RANKED_AS_DISTINCT_CAUSES', path)
    if not required_experiments.issubset(selected_codes):
        fail('SCIENTIFIC_CASE_OR_ROUTE_OMITS_RECORDED_PURPOSE_REVIEW', 'decisionReview.selectedExperiments')

    actions = review.get('validationActions')
    if not isinstance(actions, list) or not actions:
        fail('MISSING_CONCRETE_PRIORITIZED_VALIDATION', 'decisionReview.validationActions')
        actions = []
    action_ids = set()
    covered_causes = set()
    for index, action in enumerate(actions):
        path = f'decisionReview.validationActions[{index}]'
        identity(action, path)
        action_ids.add(action.get('id'))
        if action.get('causeReviewId') not in cause_ids:
            fail('VALIDATION_NOT_LINKED_TO_RANKED_CAUSE', path)
        covered_causes.add(action.get('causeReviewId'))
        if action.get('priority') not in {'P0', 'P1', 'P2'} or action.get('status') != 'PROPOSED' or action.get('executed') not in (None, False):
            fail('PRIORITY_EXPERIMENT_IS_NOT_EXPLICIT_UNEXECUTED_PROPOSAL', path)
        refs(action.get('evidenceIds'), path + '.evidenceIds')
        for field in ('controls', 'measurement', 'expectedSignature', 'proposedCriterion', 'thresholdBasis'):
            if not bilingual(action, field):
                fail('VALIDATION_LACKS_CONTROLS_MEASURED_EXPECTATION_OR_CRITERION', path + '.' + field)
        visible(action, ('controls', 'measurement', 'expectedSignature', 'proposedCriterion', 'thresholdBasis'), action.get('sectionId'), path)
        if action.get('criterionStatus') != 'PROPOSED_NOT_PREREGISTERED':
            fail('PROPOSED_REPORT_CRITERION_IS_NOT_HISTORICAL_PREREGISTRATION', path)
        signatures = action.get('discriminatingSignatures')
        if not isinstance(signatures, list) or not signatures:
            fail('MISSING_MEASURED_CAUSE_DISCRIMINATION', path)
            signatures = []
        distinct = False
        for signature in signatures:
            if not text(signature.get('measurement')) or not text(signature.get('unit')) or not bilingual(signature, 'primaryExpected') or not bilingual(signature, 'runnerUpExpected'):
                fail('INCOMPLETE_MEASURED_CAUSE_SIGNATURE', path)
            elif all(normalized(signature['primaryExpected' + lang]) != normalized(signature['runnerUpExpected' + lang]) for lang in ('En', 'Zh')):
                distinct = True
            visible(signature, ('primaryExpected', 'runnerUpExpected'), action.get('sectionId'), path + '.discriminatingSignatures')
        if not distinct:
            fail('SAME_SIGNATURE_CANNOT_DISTINGUISH_COMPETING_CAUSES', path)
        branches = action.get('branches')
        if not isinstance(branches, dict) or set(branches) != {'positive', 'negative', 'mixedInvalid'}:
            fail('MISSING_POSITIVE_NEGATIVE_MIXED_INVALID_DECISION_BRANCHES', path)
            branches = branches if isinstance(branches, dict) else {}
        for key in ('positive', 'negative', 'mixedInvalid'):
            branch = branches.get(key, {})
            if not bilingual(branch, 'condition') or not bilingual(branch, 'nextDecision'):
                fail('OUTCOME_BRANCH_LACKS_MEASURED_CONDITION_AND_NEXT_DECISION', path + '.branches.' + key)
            visible(branch, ('condition', 'nextDecision'), action.get('sectionId'), path + '.branches.' + key)
        if all(isinstance(branches.get(key), dict) for key in ('positive', 'negative')):
            for lang in ('En', 'Zh'):
                for field in ('condition', 'nextDecision'):
                    if text(branches['positive'].get(field + lang)) and normalized(branches['positive'][field + lang]) == normalized(branches['negative'].get(field + lang, '')):
                        fail('POSITIVE_AND_NEGATIVE_BRANCHES_ARE_NOT_DISTINCT', path + '.branches')
    if cause_ids - covered_causes:
        fail('RANKED_CAUSE_HAS_NO_NEXT_DECISION_TEST', 'decisionReview.validationActions')

    ledger = {entry['entryId']: entry for entry in dossier.get('ledgerEntries', [])}
    prior = None
    if prior_ledger is not None:
        prior = {entry['entryId']: entry for entry in prior_ledger.get('ledgerEntries', [])}
        for entry_id, entry in prior.items():
            current = ledger.get(entry_id)
            if not current or current.get('history', [])[:len(entry.get('history', []))] != entry.get('history', []) or current.get('projectAlias') != entry.get('projectAlias') or current.get('type') != entry.get('type'):
                fail('PRIOR_LEDGER_REMOVED_OR_HISTORY_OVERWRITTEN', 'dossier.ledgerEntries')
    issues = review.get('priorIssueReviews')
    scope = review.get('priorIssueScope')
    if not isinstance(issues, list) or not isinstance(scope, dict):
        fail('MISSING_RELEVANT_PRIOR_ISSUE_SCOPE', 'decisionReview.priorIssueReviews')
        issues = issues if isinstance(issues, list) else []
        scope = scope if isinstance(scope, dict) else {}
    selected_entries = [item.get('entryId') for item in issues]
    eligible_prior = set(prior) if prior is not None else set(ledger)
    if len(selected_entries) != len(set(selected_entries)) or not set(selected_entries).issubset(eligible_prior):
        fail('UNKNOWN_OR_DUPLICATE_PRIOR_ISSUE_REVIEW', 'decisionReview.priorIssueReviews')
    if scope.get('selectedEntryIds') != selected_entries or not bilingual(scope, 'selectionReason'):
        fail('PRIOR_ISSUE_REVIEW_SCOPE_NOT_EXPLICIT', 'decisionReview.priorIssueScope')
    omitted = scope.get('omittedUnchangedCount')
    if isinstance(omitted, bool) or not isinstance(omitted, int) or omitted != len(eligible_prior - set(selected_entries)):
        fail('INCORRECT_OMITTED_PRIOR_ISSUE_COUNT', 'decisionReview.priorIssueScope')
    for entry_id in eligible_prior - set(selected_entries):
        if prior is not None and ledger.get(entry_id) != prior[entry_id]:
            fail('CHANGED_PRIOR_ISSUE_CANNOT_BE_OMITTED_AS_UNCHANGED', 'decisionReview.priorIssueScope')
    for index, issue in enumerate(issues):
        path = f'decisionReview.priorIssueReviews[{index}]'
        entry = ledger.get(issue.get('entryId'), {})
        if issue.get('sectionId') not in sections or issue.get('currentStatus') != entry.get('status') or issue.get('revision') != entry.get('revision') or not bilingual(issue, 'analysis'):
            fail('PRIOR_ISSUE_STATUS_NOT_BOUND_TO_REVIEWED_LEDGER', path)
        visible(issue, ('analysis',), issue.get('sectionId'), path)
        if issue.get('assessment') not in {'UNCHANGED_NO_NEW_EVIDENCE', 'REVIEWED_UPDATE'}:
            fail('PRIOR_ISSUE_HAS_NO_REVIEWED_CHANGE_ASSESSMENT', path)
        evidence = refs(issue.get('evidenceIds'), path + '.evidenceIds', empty=issue.get('assessment') == 'UNCHANGED_NO_NEW_EVIDENCE')
        previous = prior.get(issue.get('entryId')) if prior is not None else None
        if previous and issue.get('assessment') == 'UNCHANGED_NO_NEW_EVIDENCE' and entry != previous:
            fail('CHANGED_ISSUE_REPORTED_AS_UNCHANGED', path)
        if issue.get('assessment') == 'REVIEWED_UPDATE':
            try:
                analysis.validate_entry(entry)
            except (ValueError, TypeError, KeyError):
                fail('ISSUE_UPDATE_LACKS_VALID_APPEND_ONLY_REVIEW', path)
            latest = (entry.get('history') or [{}])[-1]
            if not evidence or not set(evidence).issubset(latest.get('evidenceIdentifiers', [])) or (previous and entry.get('revision', 0) <= previous.get('revision', 0)):
                fail('ISSUE_UPDATE_LACKS_NEW_REVIEWED_SOURCE_EVIDENCE', path)
        if issue.get('executionStatus') not in {'NOT_VERIFIED', 'SOURCE_VERIFIED'}:
            fail('PRIOR_ADVICE_HAS_NO_EXECUTION_EVIDENCE_STATUS', path)
        if issue.get('executionStatus') == 'SOURCE_VERIFIED':
            execution_basis = issue.get('executionBasis')
            if not isinstance(execution_basis, list) or not execution_basis or not bilingual(issue, 'whyAdviceImplemented'):
                fail('ADVICE_EXECUTION_CANNOT_BE_ASSUMED_FROM_LEDGER_TEXT', path)
                execution_basis = []
            visible(issue, ('whyAdviceImplemented',), issue.get('sectionId'), path)
            if not any(ref in measurements for ref in evidence):
                fail('ADVICE_EXECUTION_CANNOT_BE_ASSUMED_FROM_LEDGER_TEXT', path)
            for basis in execution_basis:
                row = measurements.get(basis.get('measurementId'))
                valid = False
                if row and basis.get('measurementId') in evidence:
                    experiment = experiments.get(row.get('experimentCode'), {})
                    for step in experiment.get('steps', []):
                        if step.get('position') != basis.get('stepPosition'):
                            continue
                        for execution in step.get('executions', []):
                            actuals = execution.get('actuals')
                            if (execution.get('sampleAlias') != row.get('sampleAlias')
                                    or execution.get('runAlias') != row.get('runAlias')
                                    or not isinstance(actuals, dict) or not actuals
                                    or execution.get('flagged') or payload_digest(actuals) != basis.get('actualsSha256')):
                                continue
                            try:
                                valid = (public.time(execution.get('capturedAt')) <= public.time(row.get('measuredAt'))
                                         and public.time(execution.get('capturedAt')) == public.time(basis.get('capturedAt')))
                            except (ValueError, TypeError):
                                valid = False
                if not valid:
                    fail('EXECUTION_PROOF_NOT_BOUND_TO_MATCHED_RECORDED_ACTUALS', path)

    peer = review.get('peerReview')
    if not isinstance(peer, dict):
        peer = {}
    if (not text(peer.get('reviewer')) or normalized(peer.get('reviewer', '')) == normalized(review.get('preparedBy', ''))
            or peer.get('independent') is not True or peer.get('status') != 'APPROVED' or not text(peer.get('sourceReference'))):
        fail('MISSING_APPROVED_INDEPENDENT_DECISION_REVIEW', 'decisionReview.peerReview')
    checks = peer.get('checks')
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in PEER_CHECKS):
        fail('INCOMPLETE_DECISION_SCIENTIFIC_REVIEW_CHECKS', 'decisionReview.peerReview.checks')
    for key, expected in [('reviewedProjectAliases', required_projects), ('reviewedExperimentCodes', set(selected_codes)),
                          ('reviewedCauseIds', cause_ids), ('reviewedActionIds', action_ids)]:
        if not strings(peer.get(key), empty=not expected) or set(peer[key]) != expected:
            fail('INDEPENDENT_DECISION_REVIEW_HAS_COVERAGE_GAPS', 'decisionReview.peerReview.' + key)
    try:
        at = public.time(peer.get('reviewedAt'))
        if at < public.time(snapshot.get('snapshotAt')) or at > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
            fail('DECISION_REVIEW_NOT_CURRENT', 'decisionReview.peerReview.reviewedAt')
    except (ValueError, TypeError):
        fail('INVALID_DECISION_REVIEW_TIME', 'decisionReview.peerReview.reviewedAt')
    concerns = peer.get('concerns')
    if not isinstance(concerns, list):
        fail('MISSING_DECISION_REVIEW_CONCERN_RECORD', 'decisionReview.peerReview.concerns')
        concerns = []
    for concern in concerns:
        if not isinstance(concern, dict) or concern.get('severity') not in {'BLOCKING', 'ADVISORY'} or not text(concern.get('issue')) or not isinstance(concern.get('resolved'), bool):
            fail('INVALID_DECISION_REVIEW_CONCERN', 'decisionReview.peerReview.concerns')
        elif concern.get('severity') == 'BLOCKING' and concern.get('resolved') is not True:
            fail('UNRESOLVED_DECISION_REVIEW_BLOCKER', 'decisionReview.peerReview.concerns')
    return {'passed': not errors, 'gateVersion': 1, 'errors': errors,
            'counts': {'projects': len(projects), 'sourceBoundCohorts': cohort_count, 'periodPairs': comparison_count,
                       'selectedExperiments': len(selected), 'rankedCauses': len(causes), 'validationActions': len(actions),
                       'selectedPriorIssues': len(issues)}, 'scienceCertified': False,
            'priorLedgerCompared': prior_ledger is not None,
            'limitations': ['Checks source binding, exact estimands, decision coverage and declared independent review; it does not certify scientific correctness or prose quality.',
                            'No word count or arbitrary number of cases is evidence of useful judgment. Actual independent LLM scientific review and the academic, numerical, molecular and publication/privacy gates remain mandatory.',
                            'Current narrative fields are not verified historical preregistration. Proposed expectations and criteria live in the report, not in new experiment-design fields.']}


def validate(document, snapshot, dossier, prior_ledger=None):
    try:
        if not all(isinstance(value, dict) for value in (document, snapshot, dossier)) or (prior_ledger is not None and not isinstance(prior_ledger, dict)):
            raise TypeError('Invalid input object')
        return _validate(document, snapshot, dossier, prior_ledger)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, RecursionError):
        return {'passed': False, 'gateVersion': 1,
                'errors': [{'code': 'INVALID_NESTED_DECISION_INPUT_SHAPE', 'path': 'inputs'}],
                'counts': {}, 'scienceCertified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('document', 'snapshot', 'dossier'):
        parser.add_argument(name, type=Path)
    parser.add_argument('--prior-ledger', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    inputs = [json.loads(path.read_text()) for path in (args.document, args.snapshot, args.dossier)]
    prior = json.loads(args.prior_ledger.read_text()) if args.prior_ledger else None
    result = validate(*inputs, prior_ledger=prior)
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
