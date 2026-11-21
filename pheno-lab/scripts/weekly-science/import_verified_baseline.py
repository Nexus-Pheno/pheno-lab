#!/usr/bin/env python3
"""Relocate a verified four-file report baseline into an owner-private local run root."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

import select_published_baseline as selector

ARTIFACTS = (
    ('snapshot.json', 'snapshot', 'snapshotSha256'),
    ('rd-dossier-published.json', 'dossierPublished', 'dossierPublishedSha256'),
    ('report-publish.html', 'reportPublish', 'contentSha256'),
)
SOURCE_MANIFEST = 'original-run-result.json'
LOCAL_MANIFEST = 'run-result.json'


def existing_directory(path):
    if not path.is_absolute() or path.is_symlink():
        raise selector.BaselineError('IMPORT_REQUIRES_ABSOLUTE_PRIVATE_DIRECTORY')
    path = path.resolve(strict=True)
    selector.require_private(path, directory=True)
    return path


def copy_private(source, destination, limit):
    selector.require_private(source)
    if source.stat().st_size > limit:
        raise selector.BaselineError('BASELINE_INPUT_SIZE_BOUND_EXCEEDED')
    with source.open('rb') as incoming, destination.open('xb') as outgoing:
        os.fchmod(outgoing.fileno(), 0o600)
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        outgoing.flush()
        os.fsync(outgoing.fileno())


def check_html(manifest, directory):
    path = selector.inside(manifest.get('reportPublish'), directory)
    if path.stat().st_size > selector.MAX_ARTIFACT_BYTES or selector.file_sha(path) != manifest['contentSha256']:
        raise selector.BaselineError('BASELINE_HTML_HASH_MISMATCH')


def private_manifest(metadata, directory, original_hash):
    manifest = {key: metadata[key] for key in (
        'schemaVersion', 'publicationVerified', 'reportId', 'reportUrl', 'publicationKey',
        'publishedAt', 'contentSha256', 'snapshotSha256', 'dossierPublishedSha256',
        'snapshotAt', 'ledgerEntries') if key in metadata}
    for name, pointer, _ in ARTIFACTS:
        manifest[pointer] = str(directory / name)
    manifest['originalRunResultSha256'] = original_hash
    return manifest


def fsync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def install(source, root):
    source = existing_directory(source)
    root = existing_directory(root)
    if source == root or source.is_relative_to(root) or root.is_relative_to(source):
        raise selector.BaselineError('IMPORT_SOURCE_AND_BASELINE_ROOT_MUST_BE_SEPARATE')
    original = source / LOCAL_MANIFEST
    selector.require_private(original)
    metadata = selector.load_json(original, selector.MAX_METADATA_BYTES)
    selector.verify_metadata(metadata, dt.datetime.now(dt.timezone.utc))
    original_hash = selector.file_sha(original)
    target = root / metadata['publicationKey']
    manifest = private_manifest(metadata, target, original_hash)
    lock_fd = os.open(root / '.baseline-import.lock', os.O_NOFOLLOW | os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(lock_fd, 'rb+') as lock:
        selector.require_private(root / '.baseline-import.lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.exists() or target.is_symlink():
            selector.require_private(target, directory=True)
            existing = selector.inside(str(target / LOCAL_MANIFEST), root)
            if selector.load_json(existing, selector.MAX_METADATA_BYTES) != manifest:
                raise selector.BaselineError('EXISTING_BASELINE_CONFLICT')
            for name, _, hash_field in ARTIFACTS:
                submitted = source / name
                selector.require_private(submitted)
                if submitted.stat().st_size > selector.MAX_ARTIFACT_BYTES or selector.file_sha(submitted) != manifest[hash_field]:
                    raise selector.BaselineError('BASELINE_ARTIFACT_HASH_MISMATCH')
            proof = selector.inside(str(target / SOURCE_MANIFEST), root)
            if selector.file_sha(proof) != original_hash:
                raise selector.BaselineError('BASELINE_SOURCE_MANIFEST_HASH_MISMATCH')
            selector.validate_artifacts(manifest, target)
            check_html(manifest, target)
            return target, 'ALREADY_VERIFIED'
        with TemporaryDirectory(prefix='UNPUBLISHED-import-', dir=root) as scratch:
            staging = Path(scratch)
            copy_private(original, staging / SOURCE_MANIFEST, selector.MAX_METADATA_BYTES)
            if selector.file_sha(staging / SOURCE_MANIFEST) != original_hash:
                raise selector.BaselineError('BASELINE_SOURCE_MANIFEST_HASH_MISMATCH')
            # Source filenames are fixed. Historical path fields are never opened.
            for name, _, _ in ARTIFACTS:
                copy_private(source / name, staging / name, selector.MAX_ARTIFACT_BYTES)
            provisional = private_manifest(metadata, staging, original_hash)
            selector.validate_artifacts(provisional, staging)
            check_html(provisional, staging)
            with (staging / LOCAL_MANIFEST).open('x') as output:
                os.fchmod(output.fileno(), 0o600)
                json.dump(manifest, output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            fsync_dir(staging)
            staging.rename(target)
            fsync_dir(root)
    return target, 'IMPORTED_VERIFIED'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    try:
        target, status = install(args.source, args.root)
    except (selector.BaselineError, OSError) as error:
        print(json.dumps({'status': 'BLOCKED', 'errorCode': getattr(error, 'code', 'BASELINE_IO_ERROR')}))
        return 1
    print(json.dumps({'status': status, 'runResult': str(target / LOCAL_MANIFEST)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
