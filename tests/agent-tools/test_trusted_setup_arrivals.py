"""GRS-196: trusted setup arrivals, using real Git histories and the guard CLI."""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('controls', Path(__file__).with_name('test_controls.py'))
controls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(controls)


class TrustedSetupArrivals:
    config = controls.FixRoundMergedBase.config
    helper = 'tests/setup/arrived.ts'
    manifest_path = controls.FixRoundManifest.path

    def setUp(self):
        super().setUp()
        self.write('vitest.config.ts', self.config)
        self.dev = self.commit('runner before review')
        self.git('switch', '-q', '-c', 'candidate')
        self.write('tests/protected.test.ts', controls.TestWeakening.original)
        self.base = self.commit('original reviewed test')
        manifest = {'schema': 'clearcase-fix-round/1', 'unit': 'GRS-104/implementation', 'fixBase': self.base,
                    'tests': [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]}
        if self.files_mode:
            files = [{'file': 'tests/protected.test.ts', 'revision': self.base}]
            review = {'schema': 'clearcase-file-protection-review/1', 'unit': manifest['unit'], 'fixBase': self.base,
                      'reviewFindingsSha256': 'a' * 64, 'reviewedHead': self.base, 'verdict': 'PASS', 'fresh': True,
                      'reviewer': 'synthetic-reviewer', 'implementer': 'synthetic-worker', 'files': files}
            review_path = 'docs/acceptance/file-reviews/arrivals.json'
            review_bytes = self.write(review_path, json.dumps(review)).read_bytes()
            manifest.update(tests=[], reviewFindingsSha256='a' * 64,
                            protection={'kind': 'files', 'files': files,
                                        'review': {'file': review_path, 'sha256': hashlib.sha256(review_bytes).hexdigest()}})
        self.write(self.manifest_path, json.dumps(manifest))
        self.write('app.txt', 'fixed\n')
        self.fixed = self.commit('fix with original protection binding')
        self.manifest_bytes = (self.repo / self.manifest_path).read_bytes()

    def upstream(self, files):
        self.git('switch', '-q', 'dev')
        for file, text in files.items():
            self.write(file, text)
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'trusted additions')
        self.git('switch', '-q', 'candidate')

    def merge(self, ref='dev'):
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'merge', '-q', '--no-ff',
                 '-m', 'receive trusted additions', ref)

    def additions(self):
        return {'vitest.config.ts': self.config.replace('include:', f"setupFiles: ['./{self.helper}'], include:"),
                self.helper: 'export {};\n'}

    def guard(self, code=0, *args):
        out = self.cli('fix-round-guard', '--base', 'dev', *args, code=code)
        self.assertEqual((self.repo / self.manifest_path).read_bytes(), self.manifest_bytes)
        self.assertEqual(self.last_receipt()['guard']['fixBase'], self.base)
        return out

    def test_genuine_unchanged_setup_arrival_passes(self):
        self.upstream(self.additions())
        self.merge()
        self.assertIn(self.helper, self.guard())


class NamedArrivals(TrustedSetupArrivals, controls.ControlCase):
    files_mode = False


class FilesArrivals(TrustedSetupArrivals, controls.ControlCase):
    files_mode = True


if __name__ == '__main__':
    unittest.main(verbosity=2)
