#!/usr/bin/env python3
"""Select a verified immutable reporting baseline; never fall back after failure.

Run-result schema v2: publicationVerified=true, canonical reportId/reportUrl,
publicationKey/contentSha256/publishedAt, absolute snapshot/dossierPublished
pointers and their snapshotSha256/dossierPublishedSha256. Optional ledgerEntries
and snapshotAt assertions must match the frozen artifacts. Raw inputs are never
printed; this helper performs no DB, COS, publication or automation operation.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

SHA = re.compile(r'[0-9a-f]{64}\Z')
KEY = re.compile(r'[a-z0-9][a-z0-9-]{2,119}\Z')
MAX_METADATA_BYTES = 1_000_000
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_RUN_RESULTS = 1000


class BaselineError(ValueError):
    """Only safe, fixed error codes may reach logs."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def timestamp(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.utcoffset() is None:
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise BaselineError('INVALID_BASELINE_TIMESTAMP') from None


def require_private(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if info.st_uid != os.geteuid() or not kind(info.st_mode) or info.st_mode & 0o077:
        raise BaselineError('BASELINE_REQUIRES_PRIVATE_OWNER_ACCESS')
    if not directory and info.st_nlink != 1:
        raise BaselineError('BASELINE_ARTIFACT_MUST_NOT_BE_LINKED')


def inside(path, root, *, must_exist=True):
    if not isinstance(path, (str, Path)) or not Path(path).is_absolute():
        raise BaselineError('BASELINE_PATH_MUST_BE_ABSOLUTE')
    try:
        resolved = Path(path).resolve(strict=must_exist)
    except (FileNotFoundError, OSError, RuntimeError):
        raise BaselineError('BASELINE_ARTIFACT_MISSING_OR_INVALID_PATH') from None
    if not resolved.is_relative_to(root) or resolved == root:
        raise BaselineError('BASELINE_PATH_ESCAPES_PRIVATE_ROOT')
    if any(part.upper().startswith('UNPUBLISHED') for part in resolved.relative_to(root).parts):
        raise BaselineError('BASELINE_POINTS_TO_UNPUBLISHED_ARTIFACT')
    if must_exist and not resolved.is_file():
        raise BaselineError('BASELINE_ARTIFACT_NOT_A_FILE')
    if Path(path) != resolved:
        raise BaselineError('BASELINE_PATH_MUST_BE_CANONICAL')
    if must_exist:
        require_private(resolved)
        for parent in resolved.parents:
            require_private(parent, directory=True)
            if parent == root:
                break
    return resolved


def load_json(path, maximum):
    try:
        if path.stat().st_size > maximum:
            raise BaselineError('BASELINE_INPUT_SIZE_BOUND_EXCEEDED')
        value = json.loads(path.read_text())
    except BaselineError:
        raise
    except (OSError, ValueError, UnicodeError):
        raise BaselineError('INVALID_BASELINE_JSON') from None
    if not isinstance(value, dict):
        raise BaselineError('INVALID_BASELINE_OBJECT')
    return value


def file_sha(path):
    digest = hashlib.sha256()
    try:
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        raise BaselineError('BASELINE_ARTIFACT_UNREADABLE') from None
    return digest.hexdigest()


def verify_metadata(value, now):
    if value.get('schemaVersion') != 2 or value.get('publicationVerified') is not True:
        raise BaselineError('INVALID_VERIFIED_BASELINE_SCHEMA')
    identifier = value.get('reportId')
    try:
        if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
            raise ValueError()
    except (ValueError, AttributeError):
        raise BaselineError('INVALID_CANONICAL_REPORT_ID') from None
    if value.get('reportUrl') != 'https://lab.szkl.com/reports/' + identifier:
        raise BaselineError('BASELINE_REPORT_URL_MISMATCH')
    if not isinstance(value.get('publicationKey'), str) or not KEY.fullmatch(value['publicationKey']):
        raise BaselineError('INVALID_BASELINE_PUBLICATION_KEY')
    for key in ('contentSha256', 'snapshotSha256', 'dossierPublishedSha256'):
        if not isinstance(value.get(key), str) or not SHA.fullmatch(value[key]):
            raise BaselineError('INVALID_BASELINE_HASH_METADATA')
    published_at = timestamp(value.get('publishedAt'))
    if published_at > now + dt.timedelta(minutes=1):
        raise BaselineError('BASELINE_PUBLICATION_DATE_IN_FUTURE')
    if 'ledgerEntries' in value and (not isinstance(value['ledgerEntries'], int)
            or isinstance(value['ledgerEntries'], bool) or value['ledgerEntries'] < 0):
        raise BaselineError('INVALID_BASELINE_LEDGER_COUNT')
    return published_at


def validate_artifacts(metadata, root):
    snapshot_path = inside(metadata.get('snapshot'), root)
    dossier_path = inside(metadata.get('dossierPublished'), root)
    if snapshot_path == dossier_path:
        raise BaselineError('BASELINE_ARTIFACT_POINTERS_COLLIDE')
    # Hash before parsing. A changed latest baseline is an actionable integrity
    # failure, never a reason to choose an older report silently.
    for path, expected in ((snapshot_path, metadata['snapshotSha256']),
                           (dossier_path, metadata['dossierPublishedSha256'])):
        if path.stat().st_size > MAX_ARTIFACT_BYTES:
            raise BaselineError('BASELINE_INPUT_SIZE_BOUND_EXCEEDED')
        if file_sha(path) != expected:
            raise BaselineError('BASELINE_ARTIFACT_HASH_MISMATCH')
    snapshot = load_json(snapshot_path, MAX_ARTIFACT_BYTES)
    dossier = load_json(dossier_path, MAX_ARTIFACT_BYTES)
    if (snapshot.get('schemaVersion') != 1 or snapshot.get('readOnly') is not True
            or snapshot.get('truncated') is not False
            or snapshot.get('collectorIdentity') != 'deploy_pheno_lab'):
        raise BaselineError('BASELINE_SNAPSHOT_NOT_VERIFIED_READONLY')
    if (dossier.get('schemaVersion') != 1 or dossier.get('readOnlyAnalysis') is not True
            or dossier.get('classification') != 'PRIVATE_RD_DOSSIER_DO_NOT_PUBLISH_RAW'):
        raise BaselineError('BASELINE_DOSSIER_NOT_VERIFIED_PRIVATE')
    snapshot_at = timestamp(snapshot.get('snapshotAt'))
    if timestamp(dossier.get('snapshotAt')) != snapshot_at:
        raise BaselineError('BASELINE_DOSSIER_SNAPSHOT_DATE_MISMATCH')
    if 'snapshotAt' in metadata and timestamp(metadata['snapshotAt']) != snapshot_at:
        raise BaselineError('BASELINE_METADATA_SNAPSHOT_DATE_MISMATCH')
    if snapshot_at > timestamp(metadata['publishedAt']):
        raise BaselineError('BASELINE_PUBLICATION_PREDATES_SNAPSHOT')
    raw_entries = dossier.get('ledgerEntries')
    if not isinstance(raw_entries, list):
        raise BaselineError('BASELINE_LEDGER_ENTRIES_MISSING')
    try:
        helper = Path(__file__).with_name('analyze_rd_snapshot.py')
        spec = importlib.util.spec_from_file_location('baseline_rd_ledger', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        entries = module.update_ledger([dossier], [])
    except Exception:
        raise BaselineError('INVALID_BASELINE_LEDGER_HISTORY') from None
    if len(entries) != len(raw_entries):
        raise BaselineError('BASELINE_LEDGER_IDENTITIES_NOT_UNIQUE')
    if 'ledgerEntries' in metadata and len(entries) != metadata['ledgerEntries']:
        raise BaselineError('BASELINE_LEDGER_COUNT_MISMATCH')
    # Recheck bytes after parsing to fail closed on concurrent artifact changes.
    if (file_sha(snapshot_path) != metadata['snapshotSha256']
            or file_sha(dossier_path) != metadata['dossierPublishedSha256']):
        raise BaselineError('BASELINE_ARTIFACT_CHANGED_DURING_READ')
    return snapshot_path, dossier_path, len(entries), snapshot_at


def select_baseline(root, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if root.is_symlink():
        raise BaselineError('PRIVATE_RUN_ROOT_MUST_NOT_BE_SYMLINK')
    try:
        root = root.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        raise BaselineError('PRIVATE_RUN_ROOT_MISSING') from None
    if not root.is_dir():
        raise BaselineError('PRIVATE_RUN_ROOT_NOT_DIRECTORY')
    require_private(root, directory=True)
    candidates = []
    seen = 0
    # Imports relocate historical pointers. All active pointers are canonical,
    # confined to the private root and owned by the reporting account.
    for path in root.rglob('run-result.json'):
        if any(part.upper().startswith('UNPUBLISHED') for part in path.relative_to(root).parts):
            continue
        seen += 1
        if seen > MAX_RUN_RESULTS:
            raise BaselineError('BASELINE_METADATA_SCAN_BOUND_EXCEEDED')
        metadata_path = inside(path, root)
        value = load_json(metadata_path, MAX_METADATA_BYTES)
        if value.get('publicationVerified') is not True:
            continue  # Legacy initial reports and unfinished drafts are not v2 baselines.
        published_at = verify_metadata(value, now)
        candidates.append((published_at, metadata_path, value))
    if not candidates:
        raise BaselineError('NO_VERIFIED_RD_BASELINE')
    candidates.sort(key=lambda item: item[0], reverse=True)
    if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
        raise BaselineError('AMBIGUOUS_LATEST_VERIFIED_BASELINE')
    _, metadata_path, metadata = candidates[0]
    if 'reportPublish' in metadata or 'originalRunResultSha256' in metadata:
        html_path = inside(metadata.get('reportPublish'), root)
        if html_path.stat().st_size > MAX_ARTIFACT_BYTES or file_sha(html_path) != metadata['contentSha256']:
            raise BaselineError('BASELINE_HTML_HASH_MISMATCH')
    if 'originalRunResultSha256' in metadata:
        original = inside(metadata_path.parent / 'original-run-result.json', root)
        if original.stat().st_size > MAX_METADATA_BYTES or file_sha(original) != metadata['originalRunResultSha256']:
            raise BaselineError('BASELINE_SOURCE_MANIFEST_HASH_MISMATCH')
    snapshot_path, dossier_path, count, snapshot_at = validate_artifacts(metadata, root)
    return {'status': 'PUBLISHED_VERIFIED', 'sourceRunResult': str(metadata_path),
            'reportId': metadata['reportId'], 'reportUrl': metadata['reportUrl'],
            'publicationKey': metadata['publicationKey'], 'contentSha256': metadata['contentSha256'],
            'publishedAt': metadata['publishedAt'], 'snapshotAt': snapshot_at.isoformat(),
            'snapshot': str(snapshot_path), 'snapshotSha256': metadata['snapshotSha256'],
            'dossierPublished': str(dossier_path), 'dossierPublishedSha256': metadata['dossierPublishedSha256'],
            'ledgerEntries': count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = select_baseline(args.root)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
        print(json.dumps({'selected': result['sourceRunResult'], 'reportUrl': result['reportUrl'],
                          'ledgerEntries': result['ledgerEntries'], 'snapshotAt': result['snapshotAt'],
                          'publishedAt': result['publishedAt']}))
        return 0
    except BaselineError as error:
        print(json.dumps({'selected': None, 'errorCode': error.code, 'fallbackUsed': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
