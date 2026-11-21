#!/usr/bin/env python3
"""Rerun the scientific gates and reproduce the exact HTML of a completed report, offline."""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import import_verified_baseline as relocate
import render_report
import select_published_baseline as selector


class ReplayError(ValueError):
    """A fixed reason that can be logged safely."""


def checked_file(folder, name):
    return selector.inside(str(folder / name), folder)


def record(folder, name, size=selector.MAX_METADATA_BYTES):
    return selector.load_json(checked_file(folder, name), size)


def require(condition, code):
    if not condition:
        raise ReplayError(code)


def save_new(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(descriptor,'w') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary,path)
    finally:
        os.unlink(temporary)
    relocate.fsync_dir(path.parent)


def check_published_run(folder):
    manifest = record(folder, 'run-result.json')
    selector.verify_metadata(manifest, dt.datetime.now(dt.timezone.utc))
    remapped = {**manifest, 'snapshot': str(folder / 'snapshot.json'),
                'dossierPublished': str(folder / 'rd-dossier-published.json')}
    selector.validate_artifacts(remapped, folder)
    return manifest


def run_science_gates(run, prior, output, document=None):
    document = document or run / 'report-document-publish.json'
    snapshot = run / 'snapshot.json'
    dossier = run / 'rd-dossier-reviewed.json'
    common = [document, snapshot, dossier]
    gates = [
        ('primary', 'validate_primary_evidence.py', common),
        ('public', 'validate_rd_document.py', common),
        ('academic', 'validate_academic_report.py', common),
        ('decision', 'validate_decision_report.py', [*common, '--prior-ledger', prior / 'rd-dossier-published.json']),
        ('collaborator', 'validate_collaborator_report.py', [*common, '--previous-snapshot', prior / 'snapshot.json']),
        ('language', 'validate_language_review.py', [document]),
        ('privateMaterials', 'validate_material_mechanism_review.py', [run / 'private-material-review.json', snapshot]),
    ]
    results = {}
    for label, script, args in gates:
        receipt = output / (label + '-gate.json')
        result = subprocess.run([sys.executable, '-B', Path(__file__).with_name(script), *args, '--output', receipt],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
        gate = record(output, receipt.name) if receipt.exists() else {}
        results[label] = {'passed': result.returncode == 0 and gate.get('passed') is True,
                          'codes': dict(Counter(row['code'] for row in gate.get('errors', [])))}
    return results


def replay(run, prior, output):
    run, prior = relocate.existing_directory(run), relocate.existing_directory(prior)
    require(run != prior, 'DISTINCT_PRIOR_BASELINE_REQUIRED')
    require(not any(output.resolve().is_relative_to(folder) for folder in (run, prior)), 'OUTPUT_MUST_BE_SEPARATE')
    output.mkdir(mode=0o700, exist_ok=False)
    output = output.resolve(strict=True)
    prior_manifest = check_published_run(prior)
    current = check_published_run(run)
    recorded_prior = record(run, 'baseline-selection.json')
    require(recorded_prior.get('status') == 'PUBLISHED_VERIFIED' and
            all(recorded_prior.get(key) == prior_manifest[key] for key in
                ('reportId', 'publishedAt', 'contentSha256', 'snapshotSha256', 'dossierPublishedSha256')) and
            selector.timestamp(prior_manifest['publishedAt']) < selector.timestamp(current['publishedAt']) and
            current.get('priorReportId') == prior_manifest['reportId'], 'PREDECESSOR_MANIFEST_MISMATCH')

    ready = record(run, 'report-ready-manifest.json')
    expected = ready.get('verifiedArtifactHashes')
    require(isinstance(expected, dict) and ready.get('contentSha256') == current['contentSha256'],
            'FROZEN_READY_MANIFEST_MISMATCH')
    for name in ('snapshot.json', 'rd-dossier-reviewed.json', 'report-document-publish.json', 'report-publish.html',
                 'independent-scientific-review-approved.json', 'visual-qa-approved.json',
                 'independent-source-numeric-audit.json', 'private-material-review.json'):
        path = checked_file(run, name)
        require(path.stat().st_size <= selector.MAX_ARTIFACT_BYTES and selector.file_sha(path) == expected.get(name),
                'FROZEN_ARTIFACT_HASH_MISMATCH')

    science = record(run, 'independent-scientific-review-approved.json')
    require(science.get('status') == 'APPROVED' and science.get('independent') is True,
            'ORIGINAL_INDEPENDENT_REVIEW_MISSING')
    visual = record(run, 'visual-qa-approved.json')
    require(visual.get('passed') is True and visual.get('approved') is True and
            visual.get('checkedAllPrintPages') is True and visual.get('blockingFindings') == [] and
            visual.get('htmlSha256') == current['contentSha256'], 'ORIGINAL_VISUAL_REVIEW_MISMATCH')
    audit = record(run, 'independent-source-numeric-audit.json', selector.MAX_ARTIFACT_BYTES)
    require(audit.get('snapshotSha256') == current['snapshotSha256'] and
            audit.get('arithmeticFailures') == [] and isinstance(audit.get('arithmeticChecks'), int) and
            audit['arithmeticChecks'] > 0, 'ORIGINAL_INDEPENDENT_ARITHMETIC_REVIEW_MISMATCH')
    doc = record(run, 'report-document-publish.json', selector.MAX_ARTIFACT_BYTES)
    rendered = render_report.render(doc).encode('utf-8')
    require(hashlib.sha256(rendered).hexdigest() == current['contentSha256'] ==
            expected.get('report-publish.html') and len(rendered) == current.get('contentBytes'),
            'ARCHIVED_HTML_DID_NOT_REPRODUCE')

    annex = record(run, 'private-material-review.json')
    for item in annex['inputs']:
        # The private validator subsequently checks the hash and source role.
        name = item['file']
        require(isinstance(name, str) and Path(name).name == name, 'INVALID_PRIVATE_ANNEX_INPUT')
        checked_file(run, name)
    results = run_science_gates(run, prior, output)
    status = all(row['passed'] for row in results.values())
    summary = {'passed': status, 'frozenHtmlByteIdentical': True, 'contentSha256': current['contentSha256'],
               'contentBytes': len(rendered), 'originalIndependentReviewsVerified': True,
               'priorLedgerEntries': prior_manifest.get('ledgerEntries'), 'ledgerEntries': current.get('ledgerEntries'),
               'arithmeticChecksPreviouslyReviewed': audit['arithmeticChecks'], 'gates': results,
               'mode': 'OFFLINE_REPLAY', 'publicationAttempted': False}
    save_new(output / 'replay.json', summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('run', 'prior', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    try:
        result = replay(args.run, args.prior, args.output)
    except (ReplayError, selector.BaselineError) as error:
        print(json.dumps({'passed': False, 'errorCode': str(error), 'publicationAttempted': False}))
        return 1
    except (OSError, KeyError, TypeError, ValueError, subprocess.TimeoutExpired):
        print(json.dumps({'passed': False, 'errorCode': 'REPLAY_INPUT_OR_RUNTIME_FAILURE', 'publicationAttempted': False}))
        return 1
    print(json.dumps(result))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
