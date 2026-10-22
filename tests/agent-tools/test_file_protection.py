"""GRS-193: committed custom legs, original runtime anchor and independent file-review binding.
Synthetic repositories only. The CLI uses the installed guard, never fixture-owned tooling.
"""
import copy
import datetime
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('test_controls', Path(__file__).with_name('test_controls.py'))
controls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(controls)

UNIT = 'GRS-104/implementation'


class FileProtection(controls.ControlCase):
    manifest_path = 'docs/acceptance/fix-rounds/custom.json'
    review_path = 'docs/acceptance/file-reviews/custom.json'
    probe = 'tests/custom/probe.ts'
    fixture = 'tests/custom/schema.sql'
    script = "async function leg(name, run) { await run(); }\nawait leg('race', async () => { assert.equal(await request(), 409); });\n"

    def setUp(self):
        super().setUp()
        self.write('src/app.ts', 'export const value = 1;\n')
        self.base = self.commit('original runtime review: custom regression not yet added')
        self.prompt = self.document('prompt.json', {'sha': self.base, 'unresolvedFindings': [{'id': 'M1', 'severity': 'medium'}]})
        self.prompt_hash = hashlib.sha256(self.prompt.read_bytes()).hexdigest()
        self.write(self.probe, self.script)
        self.write(self.fixture, 'CREATE TABLE cases (id TEXT PRIMARY KEY);\n')
        self.write('src/app.ts', 'export const value = 2;\n')
        self.approved = self.commit('fixed runtime and new custom regression approved independently')
        self.files = [{'file': file, 'revision': self.approved} for file in [self.probe, self.fixture]]
        self.provenance = {'schema': 'clearcase-file-protection-review/1', 'unit': UNIT, 'fixBase': self.base,
                           'reviewFindingsSha256': self.prompt_hash, 'reviewedHead': self.approved,
                           'verdict': 'PASS', 'fresh': True, 'reviewer': 'independent-reviewer',
                           'implementer': 'worker', 'files': self.files}
        self.protection = {'kind': 'files', 'files': self.files, 'review': {'file': self.review_path, 'sha256': ''}}
        self.manifest = {'schema': 'clearcase-fix-round/1', 'unit': UNIT, 'fixBase': self.base,
                         'reviewFindingsSha256': self.prompt_hash, 'tests': [], 'protection': self.protection}

    def finish(self):
        provenance = self.write(self.review_path, json.dumps(self.provenance))
        self.protection['review']['sha256'] = hashlib.sha256(provenance.read_bytes()).hexdigest()
        self.write(self.manifest_path, json.dumps(self.manifest))
        self.head = self.commit('administrative protection and separate review provenance')

    def guard(self, code=0):
        return self.cli('test-guard', '--fix-base', self.base, '--findings', self.repo / self.manifest_path, code=code)

    def refuse(self):
        self.assertIn('test-guard: FAIL', self.guard(code=1))
        self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_unchanged_custom_leg_uses_approved_snapshot_without_advancing_runtime_anchor(self):
        self.finish()
        self.assertIn('file protection', self.guard())
        self.assertEqual(self.last_receipt()['guard']['fixBase'], self.base)
        self.assertEqual(self.last_receipt()['guard']['protection'], self.protection)
        self.assertIn('PASS', self.cli('fix-round-guard', '--base', self.base, '--require-manifest'))

    def test_deletion_skip_assertion_loosening_fixture_and_mode_changes_refuse(self):
        self.finish()
        variants = ['deleted', 'skipped', 'loosened', 'fixture', 'executable', 'symlink', 'gitlink']
        for variant in variants:
            with self.subTest(variant=variant):
                self.git('switch', '-q', '-C', 'candidate', self.head)
                file = self.repo / self.probe
                if variant == 'deleted': file.unlink()
                elif variant == 'skipped': file.write_text(self.script.replace("await leg('race'", "await leg.skip('race'"))
                elif variant == 'loosened': file.write_text(self.script.replace('409', '200'))
                elif variant == 'fixture': self.write(self.fixture, '-- schema disabled\n')
                elif variant == 'executable': file.chmod(0o755)
                elif variant == 'symlink':
                    file.unlink()
                    file.symlink_to('schema.sql')
                elif variant == 'gitlink':
                    file.unlink()
                    self.git('update-index', '--add', '--cacheinfo', f'160000,{self.approved},{self.probe}')
                    self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'gitlink substitution')
                    self.refuse()
                    continue
                self.commit('weaken custom regression')
                self.refuse()

    def test_mode_must_be_explicit_nonempty_and_unambiguous(self):
        self.finish()
        variants = [None, {}, {'kind': 'unknown'}, {**self.protection, 'files': []},
                    {**self.protection, 'files': [self.files[0], self.files[0]]},
                    {**self.protection, 'extra': True}]
        for protection in variants:
            with self.subTest(protection=protection):
                self.git('switch', '-q', '-C', 'candidate', self.head)
                self.write(self.manifest_path, json.dumps({**self.manifest, 'protection': protection}))
                self.commit('malformed mode')
                self.refuse()
        for extra in [{'noTests': {}}, {'tests': [{'file': self.probe, 'name': 'race'}]}]:
            self.git('switch', '-q', '-C', 'candidate', self.head)
            self.write(self.manifest_path, json.dumps({**self.manifest, **extra}))
            self.commit('mixed mode')
            self.refuse()

    def test_paths_revisions_and_provenance_fail_closed(self):
        original = copy.deepcopy(self.protection)
        original_provenance = copy.deepcopy(self.provenance)
        for value in ['HEAD', self.approved[:8], '0' * 40, self.base]:
            with self.subTest(revision=value):
                self.protection = copy.deepcopy(original)
                self.protection['files'][0]['revision'] = value
                self.manifest['protection'] = self.protection
                self.finish()
                self.refuse()
        for file in ['/tmp/probe.ts', '../probe.ts', 'tests//probe.ts', './tests/probe.ts', '.local/probe.ts', 'RAWS/probe.ts', 'tests\\probe.ts']:
            with self.subTest(file=file):
                self.protection = copy.deepcopy(original)
                self.protection['files'][0]['file'] = file
                self.manifest['protection'] = self.protection
                self.finish()
                self.refuse()
        for patch in [{'fresh': False}, {'reviewer': 'worker'}, {'verdict': 'FAIL'}, {'fixBase': self.approved},
                      {'reviewFindingsSha256': '0' * 64}, {'reviewedHead': self.base}, {'files': []}]:
            with self.subTest(review=patch):
                self.protection = copy.deepcopy(original)
                self.manifest['protection'] = self.protection
                self.provenance = {**original_provenance, **patch}
                self.finish()
                self.refuse()

    def test_hash_and_committed_review_substitution_refuse(self):
        self.finish()
        self.write(self.review_path, json.dumps({**self.provenance, 'reviewer': 'substitute'}))
        self.commit('substituted review bytes')
        self.refuse()
        self.write(self.manifest_path, json.dumps({**self.manifest, 'protection': {
            **self.protection, 'review': {'file': self.review_path, 'sha256': 'f' * 64}}}))
        self.commit('substituted hash')
        self.refuse()

    def test_nonancestor_and_noncommit_snapshot_ids_refuse_even_with_matching_review(self):
        self.git('switch', '-q', '-c', 'outside', self.approved)
        self.write('app.txt', 'unmerged independent line\n')
        outside = self.commit('snapshot HEAD never received')
        self.git('switch', '-q', '--detach', self.approved)
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'snapshot', '-m', 'annotated tag', self.approved)
        for revision in [outside, self.git('rev-parse', 'snapshot'), self.git('rev-parse', f'{self.approved}^{{tree}}')]:
            with self.subTest(revision=revision):
                self.protection['files'] = [{'file': file, 'revision': revision} for file in [self.probe, self.fixture]]
                self.provenance.update(files=self.protection['files'], reviewedHead=revision)
                self.finish()
                self.refuse()

    def test_file_mode_keeps_original_assertion_floor_and_ordinary_diff_checks(self):
        self.write('tests/other.test.ts', "test('other', () => { expect(1).toBe(1); });\n")
        self.base = self.commit('original range also contains other regression')
        self.provenance['fixBase'] = self.base
        self.manifest['fixBase'] = self.base
        self.write('app.txt', 'snapshot metadata\n')
        self.approved = self.commit('snapshot after original anchor')
        self.files = [{'file': file, 'revision': self.approved} for file in [self.probe, self.fixture]]
        self.protection['files'] = self.files
        self.provenance.update(files=self.files, reviewedHead=self.approved)
        self.write('tests/other.test.ts', "test('other', () => {});\n")
        self.finish()
        self.assertIn('assertion count fell', self.guard(code=1))
        self.write('tests/other.test.ts', "test('other', () => { expect(1).toBe(1); });\n")
        self.write('src/app.ts', 'globalThis.expect = () => true;\n')
        self.commit('runtime framework mutation')
        self.assertIn('reaches the test framework', self.guard(code=1))

    def record_prompt(self):
        # Keep the original custom findings byte stream and the first-fix anchor intact.
        current = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', '--detach', self.base)
        review = self.document('prompt-review.json', {'sha': self.base, 'findingsSha256': self.prompt_hash,
                  'unresolvedFindings': [{'id': 'M1', 'severity': 'medium'}]})
        self.cli('review-record', '--unit', UNIT, '--review', review, '--findings', self.prompt)
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        self.cli('dispatch', '--unit', UNIT, '--phase', 'initial', '--task-id', 'impl', '--deadline', deadline)
        self.cli('dispatch', '--unit', UNIT, '--phase', 'fix', '--task-id', 'fix')
        self.git('switch', '-q', '--detach', current)

    def bind_review(self, protection):
        self.cli('receipt', '--name', 'tooling', '--', 'true')
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        check = json.loads(self.check.read_text())
        self.findings = self.document('final-findings.json', {'sha': self.head, 'unresolvedFindings': [],
            'updatedAt': '2026-10-22T17:59:00+00:00'})
        self.review = self.document('final-review.json', {'schema': 'clearcase-review/1', 'sha': self.head,
            'verdict': 'PASS', 'fresh': True, 'reviewer': 'independent', 'implementer': 'worker',
            'reviewedAt': '2026-10-22T18:00:00+00:00', 'unresolvedFindings': [],
            'findingsSha256': hashlib.sha256(self.findings.read_bytes()).hexdigest(),
            'requiredChecks': [{'name': 'tooling', 'execution': check['execution'], 'inputs': check['inputs']}],
            'fileProtection': protection})
        self.cli('review-record', '--unit', UNIT, '--review', self.review, '--findings', self.findings)

    def approve(self, guard, code=0):
        return self.cli('approve', '--unit', UNIT, '--sha', self.head, '--review', self.review,
                        '--findings', self.findings, '--check-receipt', self.check, '--guard-receipt', guard,
                        '--approved-by', 'coordinator', code=code)

    def test_ledger_requires_latest_independent_review_and_binds_approval_readback(self):
        self.finish()
        self.record_prompt()
        self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts, code=1)
        self.bind_review(self.protection)
        self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts)
        receipt = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.approve(receipt)
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        row = json.loads(approved.read_text())['approval']['guard']
        self.assertFalse(row['nothingToProtect'])
        self.assertEqual(row['protection'], self.protection)
        self.cli('approval-check', '--unit', UNIT, '--sha', self.head, '--approval-receipt', approved)
        self.bind_review({**self.protection, 'files': self.files[:1]})
        self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts, code=1)
        self.approve(receipt, code=1)

    def test_file_protection_cannot_displace_preexisting_named_test_binding(self):
        prompt = json.loads(self.prompt.read_text())
        prompt['protectedTests'] = [{'file': 'tests/real.test.ts', 'name': 'original named regression'}]
        self.prompt.write_text(json.dumps(prompt))
        self.prompt_hash = hashlib.sha256(self.prompt.read_bytes()).hexdigest()
        self.provenance['reviewFindingsSha256'] = self.prompt_hash
        self.manifest['reviewFindingsSha256'] = self.prompt_hash
        self.finish()
        self.record_prompt()
        self.bind_review(self.protection)
        self.assertIn('protectedTests', self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts, code=1))
        self.guard()
        receipt = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertIn('named tests', self.approve(receipt, code=1))

    def test_later_weak_snapshot_cannot_mint_approval_or_replace_original_review(self):
        self.finish()
        self.record_prompt()
        self.bind_review(copy.deepcopy(self.protection))
        self.write(self.probe, self.script.replace('409', '200'))
        weak = self.commit('weakened later snapshot')
        for file in self.files: file['revision'] = weak
        self.provenance['reviewedHead'] = weak
        self.finish()
        # CI alone can only check internal consistency; the authoritative existing ledger refuses substitution.
        self.guard()
        self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts, code=1)
        self.manifest.update(fixBase=weak)
        self.write(self.manifest_path, json.dumps(self.manifest))
        self.commit('try advancing runtime anchor')
        self.assertIn('not the reviewed commit', self.cli('fix-round-guard', '--base', self.base, '--ledger', self.receipts, code=1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
