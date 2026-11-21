#!/usr/bin/env python3
"""Synthetic immutable baseline selection tests; no actual reporting data."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('selector', BASE / 'select_published_baseline.py')
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
NOW = dt.datetime(2026, 1, 31, tzinfo=dt.timezone.utc)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(value, indent=2))
    path.chmod(0o600)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def entry(index, report_id):
    fields = {'statement': 'Synthetic proposed controlled experiment', 'owner': None, 'status': 'proposed',
              'sourceReportIds': [report_id], 'evidenceIdentifiers': ['synthetic-scan-' + str(index)]}
    return {'entryId': 'synthetic-ledger-' + str(index), 'type': 'recommendation', 'projectAlias': 'UNASSIGNED',
            **fields, 'revision': 1, 'history': [{'revision': 1, **copy.deepcopy(fields),
                'reviewedBy': 'Synthetic reviewer', 'reviewedAt': '2026-01-29T01:00:00Z',
                'decisionNote': 'Preserve proposed status; no execution evidence.', 'supersedesEntryId': None}]}


def create_run(root, folder, published='2026-01-30T01:00:00Z', count=23):
    directory = root / folder
    directory.mkdir(mode=0o700)
    report_id = str(uuid.uuid4())
    snapshot = {'schemaVersion': 1, 'readOnly': True, 'truncated': False,
                'collectorIdentity': 'deploy_pheno_lab', 'snapshotAt': '2026-01-29T00:00:00Z'}
    dossier = {'schemaVersion': 1, 'readOnlyAnalysis': True,
               'classification': 'PRIVATE_RD_DOSSIER_DO_NOT_PUBLISH_RAW',
               'snapshotAt': snapshot['snapshotAt'], 'ledgerEntries': [entry(i, report_id) for i in range(count)]}
    snapshot_path, dossier_path = directory / 'snapshot.json', directory / 'dossier-published.json'
    metadata = {'schemaVersion': 2, 'publicationVerified': True,
                'reportId': report_id, 'reportUrl': 'https://lab.szkl.com/reports/' + report_id,
                'publicationKey': 'materials-process-weekly-synthetic-v1', 'contentSha256': 'a' * 64,
                'publishedAt': published, 'snapshotAt': snapshot['snapshotAt'], 'ledgerEntries': count,
                'snapshot': str(snapshot_path), 'snapshotSha256': write_json(snapshot_path, snapshot),
                'dossierPublished': str(dossier_path), 'dossierPublishedSha256': write_json(dossier_path, dossier)}
    result_path = directory / 'run-result.json'
    write_json(result_path, metadata)
    return result_path, metadata


class PublishedBaseline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def assert_error(self, code):
        with self.assertRaises(selector.BaselineError) as raised:
            selector.select_baseline(self.root, now=NOW)
        self.assertEqual(raised.exception.code, code)

    def test_latest_real_publication_date_beats_filename_order_and_loads_23_entries(self):
        create_run(self.root, 'z-old', '2026-01-29T02:00:00Z', count=8)
        latest, metadata = create_run(self.root, 'a-latest', '2026-01-30T02:00:00Z')
        # Unpublished drafts and legacy metadata cannot displace a verified run.
        draft = self.root / 'z-draft'
        draft.mkdir(mode=0o700)
        write_json(draft / 'rd-dossier-v99.json', {'ledgerEntries': []})
        write_json(draft / 'run-result.json', {'publicationVerified': False, 'publishedAt': '2026-01-31T00:00:00Z'})
        write_json(self.root / 'legacy' / 'run-result.json', {'verification': 'historical confirmed publication'})
        result = selector.select_baseline(self.root, now=NOW)
        self.assertEqual(result['sourceRunResult'], str(latest.resolve()))
        self.assertEqual(result['reportId'], metadata['reportId'])
        self.assertEqual(result['ledgerEntries'], 23)
        self.assertEqual(result['status'], 'PUBLISHED_VERIFIED')

    def test_missing_latest_artifact_does_not_fall_back(self):
        create_run(self.root, 'old', '2026-01-29T02:00:00Z')
        _, latest = create_run(self.root, 'latest', '2026-01-30T02:00:00Z')
        Path(latest['dossierPublished']).unlink()
        self.assert_error('BASELINE_ARTIFACT_MISSING_OR_INVALID_PATH')

    def test_hash_mismatch_does_not_fall_back(self):
        create_run(self.root, 'old', '2026-01-29T02:00:00Z')
        _, latest = create_run(self.root, 'latest', '2026-01-30T02:00:00Z')
        with Path(latest['snapshot']).open('a') as stream:
            stream.write(' ')
        self.assert_error('BASELINE_ARTIFACT_HASH_MISMATCH')

    def test_paths_outside_root_and_symlink_escape_rejected(self):
        result_path, metadata = create_run(self.root, 'run')
        with tempfile.TemporaryDirectory() as outside:
            outside_path = Path(outside) / 'private.json'
            outside_path.write_text('{}')
            metadata['snapshot'] = str(outside_path)
            write_json(result_path, metadata)
            self.assert_error('BASELINE_PATH_ESCAPES_PRIVATE_ROOT')
            linked = result_path.parent / 'escape.json'
            linked.symlink_to(outside_path)
            metadata['snapshot'] = str(linked)
            write_json(result_path, metadata)
            self.assert_error('BASELINE_PATH_ESCAPES_PRIVATE_ROOT')

    def test_metadata_symlink_escape_is_never_read(self):
        with tempfile.TemporaryDirectory() as outside:
            external = Path(outside) / 'private.json'
            external.write_text('SYNTHETIC_PRIVATE_PAYLOAD')
            folder = self.root / 'escape'
            folder.mkdir(mode=0o700)
            (folder / 'run-result.json').symlink_to(external)
            self.assert_error('BASELINE_PATH_ESCAPES_PRIVATE_ROOT')

    def test_unpublished_directory_ignored_and_unpublished_pointer_rejected(self):
        create_run(self.root, 'published')
        create_run(self.root, 'UNPUBLISHED-newest', '2026-01-30T23:00:00Z')
        result = selector.select_baseline(self.root, now=NOW)
        self.assertIn('/published/', result['sourceRunResult'])
        metadata_path = Path(result['sourceRunResult'])
        metadata = json.loads(metadata_path.read_text())
        private_draft = self.root / 'UNPUBLISHED-ledger.json'
        private_draft.write_bytes(Path(metadata['dossierPublished']).read_bytes())
        metadata['dossierPublished'] = str(private_draft)
        write_json(metadata_path, metadata)
        self.assert_error('BASELINE_POINTS_TO_UNPUBLISHED_ARTIFACT')

    def test_malformed_latest_metadata_cannot_select_older(self):
        create_run(self.root, 'old', '2026-01-29T02:00:00Z')
        path, metadata = create_run(self.root, 'latest', '2026-01-30T02:00:00Z')
        metadata['publishedAt'] = 'no timestamp'
        write_json(path, metadata)
        self.assert_error('INVALID_BASELINE_TIMESTAMP')

    def test_same_publication_timestamp_is_ambiguous(self):
        create_run(self.root, 'one')
        create_run(self.root, 'two')
        self.assert_error('AMBIGUOUS_LATEST_VERIFIED_BASELINE')

    def test_ledger_count_and_revision_history_are_validated(self):
        path, metadata = create_run(self.root, 'run')
        metadata['ledgerEntries'] = 8
        write_json(path, metadata)
        self.assert_error('BASELINE_LEDGER_COUNT_MISMATCH')
        metadata['ledgerEntries'] = 23
        dossier_path = Path(metadata['dossierPublished'])
        dossier = json.loads(dossier_path.read_text())
        dossier['ledgerEntries'][0]['revision'] = 2
        metadata['dossierPublishedSha256'] = write_json(dossier_path, dossier)
        write_json(path, metadata)
        self.assert_error('INVALID_BASELINE_LEDGER_HISTORY')

    def test_duplicate_ledger_identity_cannot_be_hidden_by_merge(self):
        path, metadata = create_run(self.root, 'run')
        dossier_path = Path(metadata['dossierPublished'])
        dossier = json.loads(dossier_path.read_text())
        dossier['ledgerEntries'].append(copy.deepcopy(dossier['ledgerEntries'][0]))
        metadata['dossierPublishedSha256'] = write_json(dossier_path, dossier)
        write_json(path, metadata)
        self.assert_error('BASELINE_LEDGER_IDENTITIES_NOT_UNIQUE')

    def test_dossier_must_match_snapshot_and_verified_readonly_contract(self):
        path, metadata = create_run(self.root, 'run')
        dossier_path = Path(metadata['dossierPublished'])
        dossier = json.loads(dossier_path.read_text())
        dossier['snapshotAt'] = '2026-01-29T00:01:00Z'
        metadata['dossierPublishedSha256'] = write_json(dossier_path, dossier)
        write_json(path, metadata)
        self.assert_error('BASELINE_DOSSIER_SNAPSHOT_DATE_MISMATCH')
        dossier['snapshotAt'] = metadata['snapshotAt']
        metadata['dossierPublishedSha256'] = write_json(dossier_path, dossier)
        snapshot_path = Path(metadata['snapshot'])
        snapshot = json.loads(snapshot_path.read_text())
        snapshot['truncated'] = True
        metadata['snapshotSha256'] = write_json(snapshot_path, snapshot)
        write_json(path, metadata)
        self.assert_error('BASELINE_SNAPSHOT_NOT_VERIFIED_READONLY')

    def test_canonical_report_id_url_hash_and_future_publication_checks(self):
        path, valid = create_run(self.root, 'run')
        for field, value, code in [
            ('reportId', 'materials-process-weekly-synthetic-v1', 'INVALID_CANONICAL_REPORT_ID'),
            ('reportUrl', 'https://lab.szkl.com/reports/another-report', 'BASELINE_REPORT_URL_MISMATCH'),
            ('contentSha256', 'NOT_HASH', 'INVALID_BASELINE_HASH_METADATA'),
            ('publishedAt', '2026-02-01T00:00:00Z', 'BASELINE_PUBLICATION_DATE_IN_FUTURE')]:
            metadata = copy.deepcopy(valid)
            metadata[field] = value
            write_json(path, metadata)
            self.assert_error(code)

    def test_empty_root_has_explicit_blocker(self):
        self.assert_error('NO_VERIFIED_RD_BASELINE')

    def test_physical_archive_root_finds_relocated_run_without_following_linked_directories(self):
        archive = self.root / 'physical-archive'
        legacy = self.root / 'old-downloads'
        archive.mkdir(mode=0o700)
        legacy.mkdir(mode=0o700)
        result_path, metadata = create_run(archive, 'published-run')
        (legacy / 'published-run').symlink_to(result_path.parent, target_is_directory=True)
        # Immutable historical metadata can still name the old absolute paths.
        metadata['snapshot'] = str(legacy / 'published-run' / 'snapshot.json')
        metadata['dossierPublished'] = str(legacy / 'published-run' / 'dossier-published.json')
        write_json(result_path, metadata)
        with self.assertRaises(selector.BaselineError) as raised:
            selector.select_baseline(legacy, now=NOW)
        self.assertEqual(raised.exception.code, 'NO_VERIFIED_RD_BASELINE')
        with self.assertRaises(selector.BaselineError) as redirected:
            selector.select_baseline(archive, now=NOW)
        self.assertEqual(redirected.exception.code, 'BASELINE_PATH_MUST_BE_CANONICAL')

    def test_missing_archive_cli_does_not_create_replacement_or_output_directory(self):
        missing = self.root / 'unmounted-archive'
        output = self.root / 'should-not-be-created' / 'selection.json'
        result = subprocess.run([sys.executable, str(BASE / 'select_published_baseline.py'),
                                 '--root', str(missing), '--output', str(output)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'selected': None,
                         'errorCode': 'PRIVATE_RUN_ROOT_MISSING', 'fallbackUsed': False})
        self.assertFalse(missing.exists())
        self.assertFalse(output.parent.exists())

    def test_root_symlink_is_still_rejected(self):
        archive = self.root / 'physical-archive'
        archive.mkdir(mode=0o700)
        create_run(archive, 'published-run')
        linked = self.root / 'linked-root'
        linked.symlink_to(archive, target_is_directory=True)
        with self.assertRaises(selector.BaselineError) as raised:
            selector.select_baseline(linked, now=NOW)
        self.assertEqual(raised.exception.code, 'PRIVATE_RUN_ROOT_MUST_NOT_BE_SYMLINK')

    def test_cli_saves_private_pointer_only_result(self):
        create_run(self.root, 'run')
        output = self.root / 'selection.json'
        result = subprocess.run([sys.executable, str(BASE / 'select_published_baseline.py'),
                                 '--root', str(self.root), '--output', str(output)], capture_output=True, text=True, check=True)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(json.loads(result.stdout)['ledgerEntries'], 23)
        self.assertNotIn('Synthetic proposed controlled experiment', result.stdout)
        self.assertNotIn('ledgerEntries\": [', output.read_text())


if __name__ == '__main__':
    unittest.main()
