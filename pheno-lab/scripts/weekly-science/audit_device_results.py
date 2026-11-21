"""Audit published application arithmetic against its selected physical-device rows."""
from collections import Counter
import hashlib
import math
import re
from statistics import mean, median, stdev


def metric_values(raw):
    result = {}
    labels = [('pce', r'pce|efficiency|^eff'), ('voc', r'voc'), ('jsc', r'jsc'), ('ff', r'^ff|fill')]
    for name, value in raw.items():
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            continue
        try:
            number = float(value)
        except ValueError:
            continue
        if math.isfinite(number):
            for key, pattern in labels:
                if re.search(pattern, name, re.I):
                    result[key] = number
                    break
    if (not 0 <= result.get('pce', 0) <= 50 or
            (result.get('pce', 0) > 0 and min(result.get('voc', 1), result.get('jsc', 1)) <= 0) or
            (any(k == 'ff' or re.search(r'^(ff|fill).*%', k, re.I) for k in raw)
             and not 0 <= result.get('ff', 0) <= 100)):
        return {}
    return result


def summary(values):
    if not values:
        return None
    ordered = sorted(values)
    def quantile(p):
        i = (len(ordered) - 1) * p
        return ordered[math.floor(i)] + (i % 1) * (ordered[math.ceil(i)] - ordered[math.floor(i)])
    return {'n': len(ordered), 'mean': mean(ordered), 'median': median(ordered), 'best': ordered[-1],
            'worst': ordered[0], 'sd': stdev(ordered) if len(ordered) > 1 else None,
            'iqr': quantile(.75) - quantile(.25)}


def raw_scans(snapshot):
    scans = {}
    for period in ('sampleMeasurements', 'historicalSampleMeasurements'):
        for row in snapshot[period]:
            alias = row.get('measurementAlias')
            if not alias or alias in scans:
                raise ValueError('Duplicate or absent source measurement alias')
            scans[alias] = row
    return scans


def audit(snapshot, previous):
    scans, prior_aliases = raw_scans(snapshot), set(raw_scans(previous))
    count = 0
    details = []
    coverage = Counter()
    for case in snapshot['sharedAppEvidence']['experiments']:
        exceptions = []
        for char in case['evidence']['characterizations']:
            selected = char['selectedResults']
            devices = {v['sampleId']: metric_values(v['metrics']) for v in selected}
            if len(devices) != len(selected) or None in devices or len(devices) != char['nSelectedDevices']:
                raise ValueError('Application device denominator differs from its selected results')
            for row in selected:
                measurement = row.get('sourceMeasurementId')
                if not measurement:
                    coverage['noLinkedInstrumentScan'] += 1
                    continue
                alias = hashlib.sha256(('pheno-report-alias-v1:'+measurement).encode()).hexdigest()[:24]
                raw = scans.get(alias)
                if raw is None:
                    coverage['outsideEligibleSnapshot'] += 1
                    exceptions.append({'measurementAlias': alias, 'status': 'OUTSIDE_ELIGIBLE_SNAPSHOT'})
                    continue
                actual = metric_values(raw.get('metrics', {}))
                bound = {'voc': .00005, 'pce': .005, 'jsc': .005, 'ff': .005}
                if (raw['experimentCode'] != case['experimentCode'] or
                    any(k not in actual or abs(v - actual[k]) > bound[k] + 1e-10 for k, v in devices[row['sampleId']].items())):
                    raise ValueError('Linked device measurement differs from accepted vector beyond instrument precision')
                coverage['linkedAtInstrumentPrecision'] += 1
            for group in char['groups']:
                group_devices = [devices[s] for s in group['sampleIds'] if s in devices]
                if len(set(group['sampleIds'])) != len(group['sampleIds']):
                    raise ValueError('Repeated physical sample in application grouping')
                for key in ('pce', 'voc', 'jsc', 'ff'):
                    observed = summary([row[key] for row in group_devices if key in row])
                    expected = group['metrics'][key]
                    if observed is None:
                        if expected is not None:
                            raise ValueError('Unmeasured group statistic has a displayed value')
                        count += 1
                        continue
                    for label, value in observed.items():
                        declared = expected[label]
                        if not (declared is None and value is None or type(declared) in (float, int) and
                                value is not None and math.isclose(value, declared, rel_tol=1e-9, abs_tol=1e-9)):
                            raise ValueError('Device statistic differs from accepted vector arithmetic')
                        count += 1
        details.append({'code': case['experimentCode'], 'sourceHash': case['evidence']['sourceHash'],
                        'sourceExceptions': exceptions})
    new = scans.keys() - prior_aliases
    return {'arithmeticChecks': count, 'arithmeticFailures': [], 'sourceCounts': dict(coverage),
            'newAliasesInHistory': len(new), 'newMeasuredInWeek': sum(scans[a].get('measuredInPeriod') is True for a in new),
            'scansReceivedInPeriodWithEarlierMeasurementTime': snapshot['ingestion']['receivedWithEarlierMeasurementInPeriod'],
            'experiments': details}
