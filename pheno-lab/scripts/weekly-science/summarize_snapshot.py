#!/usr/bin/env python3
"""Sample-first descriptive outcomes without pooling recorded protocols."""
from collections import defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import sys


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def summarize(snapshot):
    quarantined = {e['code'] for e in snapshot['experimentSummaries'] if e.get('qualityReview') or e['title'].strip().lower().startswith('[test]')}
    strata = defaultdict(list)
    for row in snapshot['sampleMeasurements']:
        if row['experimentCode'] in quarantined or row.get('group') in ('ERROR', 'EXTRA'):
            continue
        if row.get('condition', 'LIGHT') != 'LIGHT' or not finite(row['metrics'].get('pce')) or not 0 <= row['metrics']['pce'] <= 50:
            continue
        # The hash identifies the complete recorded settings, not a claim of protocol equivalence.
        settings = json.dumps(row.get('settings'), sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        protocol = hashlib.sha256(settings.encode()).hexdigest()[:16]
        key = (row['experimentCode'], row.get('runAlias'), row.get('group'), row.get('direction'), row['metrics'].get('area'), protocol)
        strata[key].append(row)
    result = []
    for key, rows in strata.items():
        samples = defaultdict(list)
        for row in rows:
            samples[row['sampleAlias']].append(row)
        metrics = {}
        for metric in ('pce', 'voc', 'jsc', 'ff'):
            medians = []
            for scans in samples.values():
                values = [r['metrics'].get(metric) for r in scans if finite(r['metrics'].get(metric))]
                if values:
                    medians.append(statistics.median(values))
            metrics[metric] = {'nSamples': len(medians), 'median': statistics.median(medians) if medians else None,
                               'min': min(medians) if medians else None, 'max': max(medians) if medians else None}
        result.append(dict(zip(('experimentCode', 'runAlias', 'group', 'direction', 'area', 'settingsHash'), key)) |
                      {'nSamples':len(samples),'nScans':len(rows),'metrics':metrics,
                       'runVerified':False,'missingRun':key[1] is None})
    return {'snapshotAt':snapshot.get('snapshotAt', snapshot.get('checkedAt')), 'strata':result,
            'method':'Within recorded run/direction/area/settings: sample medians, then group median/range; no batch verification or causal model.'}


if __name__ == '__main__':
    snapshot_path, output_path = map(Path, sys.argv[1:])
    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(output_path, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'w') as stream:
        json.dump(summarize(json.loads(snapshot_path.read_text())), stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'saved':str(output_path)}))
