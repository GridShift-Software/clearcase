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
    config = controls.FixRoundMergedBase.config.replace('include:', "setupFiles: ['./tests/setup/boot.ts'], include:")
    helper = 'tests/setup/arrived.ts'
    manifest_path = controls.FixRoundManifest.path

    def setUp(self):
        super().setUp()
        self.write('vitest.config.ts', self.config)
        self.write('tests/setup/boot.ts', 'export {};\n')
        self.write('tests/setup/dormant.ts', 'export {};\n')
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
        self.commit('trusted additions')
        self.git('switch', '-q', 'candidate')

    def merge(self, ref='dev'):
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'merge', '-q', '--no-ff',
                 '-m', 'receive trusted additions', ref)

    def additions(self):
        return {'vitest.config.ts': self.config.replace("'./tests/setup/boot.ts'", f"'./tests/setup/boot.ts', './{self.helper}'"),
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

    def restore(self):
        self.git('switch', '-q', '-C', 'candidate', self.fixed)
        self.git('branch', '-f', 'dev', self.dev)

    def test_direct_transitive_shared_cyclic_and_mixed_arrivals_keep_every_descendant_protected(self):
        for shape, graph in (
                ('direct', {'arrived': []}),
                ('transitive', {'arrived': ['middle'], 'middle': ['leaf'], 'leaf': []}),
                ('shared', {'arrived': ['left', 'right'], 'left': ['leaf'], 'right': ['leaf'], 'leaf': []}),
                ('cyclic', {'arrived': ['middle'], 'middle': ['leaf'], 'leaf': ['arrived']})):
            for mixed in (False, True):
                with self.subTest(shape=shape, mixed=mixed):
                    self.restore()
                    files = self.additions()
                    files.update({f'tests/setup/{name}.ts': ''.join(f"import './{target}';\n" for target in targets)
                                  + 'export {};\n' for name, targets in graph.items()})
                    if mixed:
                        files['tests/deployment/vitest.config.ts'] = "import '../setup/arrived';\nexport default {};\n"
                    self.upstream(files)
                    self.merge()
                    self.guard()
                    leaf = 'tests/setup/leaf.ts' if 'leaf' in graph else self.helper
                    self.write(leaf, 'export const weakened = true;\n')
                    self.commit('candidate weakens a protected descendant')
                    self.assertIn('protected dependency added/deleted', self.guard(1))

    def test_existing_protected_setup_can_receive_a_new_transitive_helper(self):
        self.upstream({'tests/setup/boot.ts': "import './arrived';\nexport {};\n", self.helper: 'export {};\n'})
        self.merge()
        self.assertIn(self.helper, self.guard())
        self.write(self.helper, 'export const weakened = true;\n')
        self.commit('candidate changes the transitive helper')
        self.assertIn('protected dependency added/deleted', self.guard(1))

    def test_candidate_additions_edits_deletions_modes_and_symlinks_refuse(self):
        for action in ('add', 'edit', 'comment', 'delete', 'mode', 'symlink', 'revert-edit', 'remerge-deletion'):
            with self.subTest(action=action):
                self.restore()
                if action == 'add':
                    for file, text in self.additions().items():
                        self.write(file, text)
                else:
                    self.upstream(self.additions())
                    self.merge()
                    file = self.repo / self.helper
                    if action in ('delete', 'symlink', 'remerge-deletion'):
                        file.unlink()
                        if action == 'symlink':
                            file.symlink_to('boot.ts')
                    elif action == 'mode':
                        file.chmod(0o755)
                    else:
                        self.write(self.helper, 'export {};\n// candidate edit\n' if action == 'comment'
                                   else 'export const weakened = true;\n')
                self.commit(f'candidate {action}')
                if action in ('revert-edit', 'remerge-deletion'):
                    self.write(self.helper, 'export {};\n')
                    self.commit('restore trusted bytes after candidate change')
                self.assertIn('test-guard: FAIL', self.guard(1))

    def test_prearrival_copy_unmerged_other_origin_and_implicit_trust_refuse(self):
        for action in ('prearrival', 'deleted-prearrival', 'copy', 'unmerged', 'other-origin', 'implicit', 'moved-base'):
            with self.subTest(action=action):
                self.restore()
                if action in ('prearrival', 'deleted-prearrival'):
                    self.write(self.helper, 'export {};\n')
                    self.commit('candidate creates helper before trusted arrival')
                    if action == 'deleted-prearrival':
                        (self.repo / self.helper).unlink()
                        self.commit('candidate removes its earlier helper')
                if action == 'other-origin':
                    self.git('switch', '-q', '-c', 'other', self.dev)
                    for file, text in self.additions().items():
                        self.write(file, text)
                    self.commit('untrusted side branch additions')
                    self.git('switch', '-q', 'candidate')
                    self.merge('other')
                self.upstream(self.additions())
                if action == 'copy':
                    for file, text in self.additions().items():
                        self.write(file, text)
                    self.commit('copy without merging')
                elif action != 'unmerged':
                    self.merge()
                if action == 'unmerged':
                    # The setup itself is copied, with no ancestor relationship to the trusted additions.
                    for file, text in self.additions().items():
                        self.write(file, text)
                    self.commit('unmerged setup copy')
                if action == 'moved-base':
                    self.upstream({'docs/later.md': 'later\n'})
                if action == 'implicit':
                    out = self.cli('fix-round-guard', code=1)
                    self.assertIsNone(self.last_receipt()['guard']['trustedBase'])
                else:
                    out = self.guard(1)
                self.assertRegex(out, r'protected dependency (added/deleted|changed)')

    def test_trusted_updates_after_arrival_and_unrelated_candidate_commits_pass(self):
        self.upstream(self.additions())
        self.merge()
        self.write('app.txt', 'another runtime fix\n')
        self.commit('unrelated candidate edit')
        self.upstream({self.helper: 'export const strengthened = true;\n'})
        self.merge()
        self.assertIn(self.helper, self.guard())

    def test_octopus_arrival_and_edited_merge_resolution_still_refuse(self):
        for action in ('octopus', 'edited-merge'):
            with self.subTest(action=action):
                self.restore()
                self.upstream(self.additions())
                if action == 'octopus':
                    self.git('switch', '-q', '-c', 'side', self.dev)
                    self.write('docs/side.md', 'unrelated\n')
                    self.commit('side branch')
                    self.git('switch', '-q', 'candidate')
                    self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'merge', '-q',
                             '--no-ff', '-m', 'unsupported octopus arrival', 'dev', 'side')
                else:
                    self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'merge', '-q',
                             '--no-ff', '--no-commit', 'dev')
                    self.write(self.helper, 'export const weakened = true;\n')
                    self.commit('candidate edits the arrival merge')
                    self.write(self.helper, 'export {};\n')
                    self.commit('restore exact trusted bytes')
                self.assertIn('protected dependency added/deleted', self.guard(1))

    def test_arrival_does_not_waive_the_original_named_test_or_file_snapshot(self):
        self.upstream(self.additions())
        self.merge()
        self.write('tests/protected.test.ts', controls.TestWeakening.original.replace('toEqual(false)', 'toBeDefined()'))
        self.commit('candidate weakens the original protection')
        out = self.guard(1)
        self.assertIn('file protection' if self.files_mode else 'named test changed', out)

    def test_existing_unprotected_origin_cannot_claim_arrival_by_gaining_setup_or_cyclic_roles(self):
        for cyclic in (False, True):
            with self.subTest(cyclic=cyclic):
                self.restore()
                files = {'tests/setup/boot.ts': "import './dormant';\nexport {};\n"}
                if cyclic:
                    files.update({'tests/setup/dormant.ts': "import './arrived';\nexport {};\n",
                                  self.helper: "import './dormant';\nexport {};\n",
                                  'tests/deployment/vitest.config.ts': "import '../setup/arrived';\nexport default {};\n"})
                self.upstream(files)
                self.merge()
                self.assertIn('protected dependency added/deleted: tests/setup/dormant.ts', self.guard(1))

    def test_runner_overlap_cannot_hide_a_candidate_origin_in_a_cycle(self):
        self.write('tests/setup/leaf.ts', "import './arrived';\nexport {};\n")
        self.commit('candidate supplies one cyclic dependency before arrival')
        files = self.additions()
        files.update({'tests/deployment/vitest.config.ts': "import '../setup/arrived';\nexport default {};\n",
                      self.helper: "import './leaf';\nexport {};\n",
                      'tests/setup/leaf.ts': "import './arrived';\nexport {};\n"})
        self.upstream(files)
        self.merge()
        self.assertIn('protected dependency added/deleted: tests/setup/leaf.ts', self.guard(1))


class NamedArrivals(TrustedSetupArrivals, controls.ControlCase):
    files_mode = False


class FilesArrivals(TrustedSetupArrivals, controls.ControlCase):
    files_mode = True


if __name__ == '__main__':
    unittest.main(verbosity=2)
