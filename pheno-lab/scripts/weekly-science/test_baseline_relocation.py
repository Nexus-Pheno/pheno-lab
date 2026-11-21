"""Synthetic tests for immutable server imports, privacy and replay."""
import json
from pathlib import Path
import tempfile
import unittest

import import_verified_baseline as importer
import select_published_baseline as selector
from test_published_baseline import create_run, write_json


class BaselineRelocation(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        private = Path(temp.name).resolve()
        self.root = private / 'baselines'
        self.root.mkdir(mode=0o700)
        path, self.metadata = create_run(private, 'transfer')
        self.source = path.parent
        dossier = self.source / 'rd-dossier-published.json'
        Path(self.metadata['dossierPublished']).rename(dossier)
        # These historical paths don't exist here. Only checked bytes get used.
        self.metadata['dossierPublished'] = '/old/science/dossier.json'
        self.metadata['snapshot'] = '/old/science/snapshot.json'
        html = self.source / 'report-publish.html'
        html.write_bytes(b'<p>Synthetic bilingual report.</p>')
        html.chmod(0o600)
        self.metadata['contentSha256'] = selector.file_sha(html)
        write_json(path, self.metadata)

    def test_relocates_original_bytes_and_full_ledger_and_repeats_without_overwrite(self):
        target, status = importer.install(self.source, self.root)
        self.assertEqual(status, 'IMPORTED_VERIFIED')
        result = selector.select_baseline(self.root)
        self.assertEqual(result['ledgerEntries'], self.metadata['ledgerEntries'])
        self.assertEqual(Path(result['snapshot']).parent, target)
        for name, _, _ in importer.ARTIFACTS:
            self.assertEqual((target / name).read_bytes(), (self.source / name).read_bytes())
            self.assertEqual((target / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual((target / 'original-run-result.json').read_bytes(), (self.source / 'run-result.json').read_bytes())
        self.assertEqual(importer.install(self.source, self.root), (target, 'ALREADY_VERIFIED'))

    def test_corrupted_html_cannot_be_installed_or_selected(self):
        html = self.source / 'report-publish.html'
        data = html.read_bytes()
        html.write_bytes(data+b' ')
        with self.assertRaisesRegex(selector.BaselineError, 'HTML_HASH_MISMATCH'):
            importer.install(self.source, self.root)
        self.assertFalse((self.root / self.metadata['publicationKey']).exists())
        html.write_bytes(data)
        target, _ = importer.install(self.source, self.root)
        (target / html.name).write_bytes(data+b' ')
        with self.assertRaisesRegex(selector.BaselineError, 'HTML_HASH_MISMATCH'):
            selector.select_baseline(self.root)

    def test_changed_original_proof_or_different_id_never_overwrites(self):
        target, _ = importer.install(self.source, self.root)
        original = (target / 'run-result.json').read_bytes()
        self.metadata['ledgerEntries'] = 2
        write_json(self.source / 'run-result.json', self.metadata)
        with self.assertRaisesRegex(selector.BaselineError, 'EXISTING_BASELINE_CONFLICT'):
            importer.install(self.source, self.root)
        self.assertEqual(original, (target / 'run-result.json').read_bytes())
        proof = target / 'original-run-result.json'
        proof.write_bytes(proof.read_bytes()+b' ')
        with self.assertRaisesRegex(selector.BaselineError, 'SOURCE_MANIFEST_HASH_MISMATCH'):
            selector.select_baseline(self.root)

    def test_unsafe_modes_and_symlinked_payloads_are_rejected(self):
        snapshot = self.source / 'snapshot.json'
        snapshot.chmod(0o644)
        with self.assertRaisesRegex(selector.BaselineError, 'PRIVATE_OWNER_ACCESS'):
            importer.install(self.source, self.root)
        snapshot.rename(self.source / 'other')
        snapshot.symlink_to(self.source / 'other')
        with self.assertRaisesRegex(selector.BaselineError, 'PRIVATE_OWNER_ACCESS'):
            importer.install(self.source, self.root)

    def test_source_contained_in_baselines_is_rejected(self):
        with self.assertRaisesRegex(selector.BaselineError, 'MUST_BE_SEPARATE'):
            importer.install(self.source, self.source.parent)
