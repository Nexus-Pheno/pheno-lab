#!/usr/bin/env python3
"""Collect bounded private lab history locally as the existing server deployment account."""
import argparse
import datetime as dt
import json
import importlib.util
import os
import re
from pathlib import Path
import shlex
import subprocess

APP_ROOT = Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location('shared_app_evidence', Path(__file__).with_name('shared_app_evidence.py'))
shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shared)


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise argparse.ArgumentTypeError('Use an ISO timestamp.') from error
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError('Timestamp needs a timezone offset.')
    return parsed


def window_values(start, end, period_start=None, history_start=None, now=None):
    """Keep the weekly period inside context and history bounded; no silent clipping."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if not start < end or end > now + dt.timedelta(minutes=1):
        raise ValueError('Use a past, nonempty half-open window.')
    if end - start > dt.timedelta(days=95):
        raise ValueError('Context window must not exceed 95 days.')
    period_start = period_start or max(start, end - dt.timedelta(days=7))
    history_start = history_start or min(start, end - dt.timedelta(days=90))
    if not history_start <= start <= period_start < end:
        raise ValueError('Use history-start <= start <= period-start < end.')
    if end - history_start > dt.timedelta(days=366):
        raise ValueError('Historical window must not exceed 366 days.')
    return {
        'REPORT_HISTORY_START': history_start,
        'REPORT_WINDOW_START': start,
        'REPORT_PERIOD_START': period_start,
        'REPORT_WINDOW_END': end,
    }


def collect_app_evidence(snapshot, codes, reader_email):
    codes = sorted(set(codes if codes is not None else shared.selected_experiment_codes(snapshot)))
    if len(codes) > 250:
        raise ValueError('Choose an explicit bounded primary-evidence case scope; do not truncate it.')
    request = {'organizationSlug': 'pheno', 'readerEmail': reader_email,
               'experimentCodes': codes, 'sourceSnapshotAt': snapshot['snapshotAt'],
               'reportWindowEnd': snapshot['windowEnd']}
    payload = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
    delimiter = 'PHENO_READONLY_SHARED_EVIDENCE_20261028'
    if delimiter in payload:
        raise ValueError('Invalid evidence request delimiter')
    script = """set +x
set -euo pipefail
[ "$(id -un)" = 'deploy_pheno_lab' ]
: "${DATABASE_URL:?Missing service environment}"
NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/export-report-evidence.ts <<'""" + delimiter + "'\n" + payload + '\n' + delimiter + '\n'
    result = subprocess.run(['bash', '-s'], cwd=APP_ROOT, input=script, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Shared app evidence read failed; preserve the draft and verify current access/deployed exporter.')
    value = json.loads(result.stdout.strip().splitlines()[-1])
    return shared.validate_export(value, snapshot, codes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-operator', action='store_true', required=True,
                        help='Run only on the Pheno server under the existing deployment account.')
    parser.add_argument('--start', required=True, type=timestamp,
                        help='Context start, normally 30 days before end (legacy windowStart).')
    parser.add_argument('--end', required=True, type=timestamp)
    parser.add_argument('--period-start', type=timestamp,
                        help='Weekly progress start; defaults to the last seven days within context.')
    parser.add_argument('--history-start', type=timestamp,
                        help='Historical comparison start; defaults to 90 days, maximum 366 days.')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--with-app-evidence', action='store_true',
                        help='Use the deployed shared device-result policy for the 28 October method revision.')
    parser.add_argument('--evidence-code', action='append', default=None,
                        help='Explicit primary experiment scope; repeat for each reviewed case. Default: current-period measured/new/updated cases.')
    parser.add_argument('--recipient-email', action='append', required=True,
                        help='Existing approved recipient; once per member of the fixed weekly roster.')
    parser.add_argument('--evidence-reader-email', required=True,
                        help='Existing authorized report/experiment reader; no grant is added.')
    args = parser.parse_args()
    recipients = args.recipient_email
    if (len(recipients) != 5 or len(set(recipients)) != 5
            or args.evidence_reader_email not in recipients
            or any(not isinstance(mail, str) or not re.fullmatch(r'[a-z0-9.+_-]+@[a-z0-9.-]+\.[a-z]+', mail) for mail in recipients)):
        parser.error('Supply the five different approved recipient emails, including the evidence reader.')
    try:
        windows = window_values(args.start, args.end, args.period_start, args.history_start)
    except ValueError as error:
        parser.error(str(error))
    if args.output.exists():
        parser.error('Output already exists; preserve the frozen snapshot.')
    collector = Path(__file__).with_name('snapshot.sh').read_text()
    # The local shell verifies its service identity before sourcing server settings.
    prefix = '\n'.join('export ' + key + '=' + shlex.quote(value.isoformat())
                       for key, value in windows.items()) + '\n'
    prefix += 'export REPORT_RECIPIENTS=' + shlex.quote(json.dumps(recipients)) + '\n'
    prefix += 'export REPORT_READER_EMAIL=' + shlex.quote(args.evidence_reader_email) + '\n'
    result = subprocess.run(['bash', '-s'], cwd=APP_ROOT, input=prefix + collector, text=True,
                            capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Read-only snapshot failed; no remote output or credentials are logged.')
    snapshot = json.loads(result.stdout)
    if (snapshot.get('schemaVersion') != 1 or snapshot.get('readOnly') is not True
            or snapshot.get('collectorIdentity') != 'deploy_pheno_lab'
            or snapshot.get('truncated') is not False):
        raise RuntimeError('Unexpected snapshot contract.')
    if args.evidence_code and not args.with_app_evidence:
        parser.error('--evidence-code requires --with-app-evidence')
    if args.with_app_evidence:
        snapshot['sharedAppEvidence'] = collect_app_evidence(
            snapshot, args.evidence_code, args.evidence_reader_email)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(snapshot, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'saved': str(args.output), 'snapshotAt': snapshot['snapshotAt'],
                      'contexts': len(snapshot['experimentSummaries']),
                      'scans': snapshot['recentScans'], 'historyScans': snapshot['historyScans'],
                      'periodEligible': snapshot['periodEligibleScans'],
                      'sharedAppEvidenceExperiments': len((snapshot.get('sharedAppEvidence') or {}).get('experiments', []))}))


if __name__ == '__main__':
    main()
