"""GRS-156: a docs-only fix round. The review named no test, so its manifest lists none and says why in a no-test
declaration bound to the reviewed commit and the review's findings hash. The real guard, the ledger and approval must all
accept it for a range that changes Markdown documentation only, refuse it otherwise, and carry it into the wave pull
request. Synthetic repositories only; run with python3 -I."""
import datetime
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

# -I leaves the script's directory off sys.path; bind only the base class, so unittest does not rerun the suite's tests
_spec = importlib.util.spec_from_file_location('test_controls', Path(__file__).with_name('test_controls.py'))
controls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(controls)
ControlCase = controls.ControlCase

UNIT = 'GRS-104/implementation'
BRANCH = 'feature/grs-104-tooling'
WAVE = 'wave/tooling'
NAMED = [{'file': 'tests/app.test.ts', 'name': 'keeps the value'}]
DROP = object()


class DocsOnlyFixRound(ControlCase):
    """dev, a wave cut from it and a ticket cut from the wave. The ticket's reviewed commit changes the app; its fix
    round corrects a guide and commits the manifest."""
    path = 'docs/acceptance/fix-rounds/GRS-104-1.json'
    test = "import { test, expect } from 'vitest';\ntest('keeps the value', () => { expect(1).toEqual(1); });\n"
    unit = UNIT
    prepare = controls.ApprovalLedger.prepare

    def setUp(self):
        super().setUp()
        self.write('src/app.ts', 'export const value = 1;\n')
        self.write('tests/app.test.ts', self.test)
        self.write('docs/guide.md', '# Guide\n\nThe old step.\n')
        self.dev = self.commit('dev: an app, its test and a guide')
        self.git('switch', '-q', '-c', WAVE)
        self.git('switch', '-q', '-c', BRANCH)
        self.write('src/app.ts', 'export const value = 2;\n')
        self.reviewed = self.commit('the implementation, as reviewed')
        self.saved_review([])

    def saved_review(self, protected):
        """The reviewer's findings file for the reviewed commit, naming `protected`."""
        self.review_findings = self.document('review-findings.json', {
            'sha': self.reviewed, 'updatedAt': '2026-10-20T11:44:10+00:00',
            'unresolvedFindings': [{'id': 'M1', 'severity': 'medium'}], 'protectedTests': protected})
        self.findings_sha = hashlib.sha256(self.review_findings.read_bytes()).hexdigest()

    def record(self, protected):
        """The saved review in the coordinator's ledger, then the unit's initial and fix dispatches. Run at the
        reviewed commit."""
        self.saved_review(protected)
        first = self.document('first-review.json', {
            'schema': 'clearcase-review/1', 'sha': self.reviewed, 'verdict': 'FAIL', 'findingsSha256': self.findings_sha,
            'unresolvedFindings': [{'id': 'M1', 'severity': 'medium'}]})
        self.cli('review-record', '--unit', UNIT, '--review', first, '--findings', self.review_findings)
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        self.cli('dispatch', '--unit', UNIT, '--phase', 'initial', '--task-id', 'impl', '--deadline', deadline)
        self.cli('dispatch', '--unit', UNIT, '--phase', 'fix', '--task-id', 'fix')

    def declaration(self, **overrides):
        data = {'reviewSha': self.reviewed, 'reviewFindingsSha256': self.findings_sha,
                'reason': 'M1 is a documentation finding; the review names no test to protect.', **overrides}
        return {key: value for key, value in data.items() if value is not DROP}

    def manifest(self, fix_base=None, declaration=None, **overrides):
        data = {'schema': 'clearcase-fix-round/1', 'unit': UNIT, 'fixBase': fix_base or self.reviewed,
                'reviewFindingsSha256': self.findings_sha, 'tests': [],
                'noTests': self.declaration() if declaration is None else declaration, **overrides}
        self.write(self.path, json.dumps({key: value for key, value in data.items() if value is not DROP}))

    def fix_round(self, files=None, **manifest):
        """The fix round: the guide corrected, any other files, and the manifest, in one commit."""
        self.write('docs/guide.md', '# Guide\n\nThe corrected step.\n')
        for name, text in (files or {}).items():
            self.write(name, text)
        self.manifest(**manifest)
        return self.commit('the docs fix round')

    def reset(self):
        self.git('switch', '-q', '-C', BRANCH, self.reviewed)

    def merge(self, ref):
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'merge', '-q', '--no-ff',
                 '-m', f'Merge {ref}', ref)
        return self.git('rev-parse', 'HEAD')

    def guard(self, *args, code=0, base=WAVE, branch=BRANCH):
        return self.cli('fix-round-guard', '--base', base, '--branch', branch, '--require-manifest', *args, code=code)

    def strict(self, code=0):
        """test-guard against the reviewed commit alone, as approval needs it; returns the receipt's path."""
        self.cli('test-guard', '--fix-base', self.reviewed, '--findings', self.repo / self.path, code=code)
        return sorted(self.receipts.glob('*/receipt.json'))[-1]

    def approve(self, *extra, code=0):
        return self.cli('approve', '--unit', UNIT, '--sha', self.sha, '--review', self.review, '--findings', self.findings,
                        '--check-receipt', self.check, '--approved-by', 'coordinator', *extra, code=code)

    def another_ticket(self, name='feature/grs-105-other', start=WAVE):
        """A later ticket of the wave with a runtime and a test change (src/<slug>.ts, tests/<slug>.test.ts), merged
        into the wave through its own merge."""
        slug = name.rsplit('/', 1)[-1]
        self.git('switch', '-q', '-c', name, start)
        self.write(f'src/{slug}.ts', 'export const other = 1;\n')
        self.write(f'tests/{slug}.test.ts', "import { test, expect } from 'vitest';\ntest('other', () => { expect(2).toEqual(2); });\n")
        self.commit('another ticket: a runtime and a test change')
        self.git('switch', '-q', WAVE)
        return self.merge(name)


class Accepted(DocsOnlyFixRound):
    def test_a_truthful_docs_only_fix_round_passes_the_fix_round_guard(self):
        head = self.fix_round()
        out = self.guard()
        receipt = self.last_receipt()
        self.assertEqual((receipt['name'], receipt['result'], receipt['revision']['head']), ('test-guard', 'PASS', head))
        self.assertIn('test-guard: PASS (docs-only, no tests named', out)
        self.assertEqual(receipt['guard']['tests'], [])
        self.assertEqual(receipt['guard']['noTests']['reviewSha'], self.reviewed)
        self.assertEqual(receipt['guard']['noTests']['reviewFindingsSha256'], self.findings_sha)
        self.assertEqual(json.loads(self.strict().read_text())['result'], 'PASS')

    def test_the_declaration_may_come_before_or_after_the_docs_fix(self):
        # A docs-only round has no red test, so the manifest's place in the round does not matter: the guard judges
        # the whole range at HEAD. GRS-154's draft manifest followed its docs fix.
        orders = {'manifest first': ('manifest', 'docs'), 'manifest after the docs fix (GRS-154)': ('docs', 'manifest')}
        for label, order in orders.items():
            with self.subTest(order=label):
                self.reset()
                for step in order:
                    if step == 'manifest':
                        self.manifest()
                    else:
                        self.write('docs/guide.md', '# Guide\n\nThe corrected step.\n')
                    self.commit(step)
                self.guard()
                self.assertEqual(self.last_receipt()['result'], 'PASS')

    def test_any_markdown_outside_code_and_test_directories_is_documentation(self):
        self.fix_round({'AGENTS.md': '# Agents\n', '.agents/skills/verify/SKILL.md': '# Skill\n',
                        '.github/pull_request_template.md': '# Template\n', 'docs/acceptance/CC-11/reviewer-guide.md': '# Guide\n'})
        self.guard()


class Refused(DocsOnlyFixRound):
    def assertRefused(self, out, *needles):
        self.assertIn('test-guard: FAIL', out)
        for needle in needles:
            self.assertIn(needle, out)
        self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_a_declaration_without_its_review_binding_or_reason_refuses(self):
        cases = {
            'no reviewed commit': {'declaration': self.declaration(reviewSha=DROP)},
            'no findings hash': {'declaration': self.declaration(reviewFindingsSha256=DROP)},
            'no reason': {'declaration': self.declaration(reason=DROP)},
            'a blank reason': {'declaration': self.declaration(reason='  ')},
            'no findings hash in the manifest': {'reviewFindingsSha256': DROP},
            'not an object': {'declaration': ['docs-only']},
            'an unknown field': {'declaration': self.declaration(scope='runtime')},
        }
        for label, manifest in cases.items():
            with self.subTest(bypass=label):
                self.reset()
                self.fix_round(**manifest)
                self.assertRefused(self.guard(code=1), 'no-test declaration')

    def test_a_declaration_bound_to_another_review_refuses(self):
        cases = {
            'a reviewed commit other than the fix base': {'declaration': self.declaration(reviewSha=self.dev)},
            'an abbreviated reviewed commit': {'declaration': self.declaration(reviewSha=self.reviewed[:12])},
            'another findings hash': {'declaration': self.declaration(reviewFindingsSha256='0' * 64)},
        }
        for label, manifest in cases.items():
            with self.subTest(bypass=label):
                self.reset()
                self.fix_round(**manifest)
                self.assertRefused(self.guard(code=1), 'no-test declaration')

    def test_a_consistent_declaration_for_a_later_commit_is_refused_by_the_ledger_and_approval(self):
        # CI has no ledger: a declaration that names a later commit throughout passes there, and the ledger and
        # approval bind it to the review they recorded.
        self.record([])
        self.write('src/app.ts', 'export const value = 3;\n')
        later = self.commit('a runtime change after the review')
        self.write('docs/guide.md', '# Guide\n\nThe corrected step.\n')
        self.manifest(fix_base=later, declaration=self.declaration(reviewSha=later))
        self.commit('a docs fix round declared from the later commit')
        self.guard()
        self.assertIn('ledger', self.cli('fix-round-guard', '--base', WAVE, '--ledger', self.receipts, '--branch', BRANCH, code=1))
        self.cli('test-guard', '--fix-base', later, '--findings', self.repo / self.path)
        receipt = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('fix base', self.approve('--guard-receipt', receipt, code=1))

    def test_a_declaration_cannot_leave_out_the_tests_the_review_named(self):
        self.record(NAMED)
        self.fix_round()
        out = self.cli('fix-round-guard', '--base', WAVE, '--ledger', self.receipts, '--branch', BRANCH, code=1)
        self.assertIn('declares no tests, but the review', out)
        receipt = self.strict()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('declares no tests, but the review', self.approve('--guard-receipt', receipt, code=1))

    def test_a_manifest_names_tests_or_declares_none_never_both(self):
        for label, manifest in {'named tests beside it': {'tests': NAMED},
                                'assertion count reasons beside it': {'assertionCountReasons': {'tests/app.test.ts': 'Tidy'}}}.items():
            with self.subTest(bypass=label):
                self.reset()
                self.fix_round(**manifest)
                self.assertRefused(self.guard(code=1), 'no-test declaration')

    def test_a_runtime_or_test_byte_in_a_declared_docs_only_range_refuses(self):
        cases = {
            'the module under review': {'src/app.ts': 'export const value = 3;\n'},
            'a root file that is not Markdown': {'app.txt': 'fixed\n'},
            'a test': {'tests/app.test.ts': self.test.replace('toEqual(1)', 'toBeDefined()')},
            'a shell test (GRS-155)': {'tests/ci-guard/run.sh': 'exit 0\n'},
            'the workflow (GRS-155)': {'.github/workflows/ci.yml': 'name: CI\n'},
            'Markdown under tests': {'tests/fixtures/notes.md': '# Fixture\n'},
            'Markdown under src': {'src/lib/README.md': '# Lib\n'},
            'Markdown under scripts': {'scripts/notes.md': '# Notes\n'},
            'Markdown under static': {'static/notes.md': '# Served\n'},
            'a Markdown name in capitals': {'docs/NOTES.MD': '# Notes\n'},
            'another fix round\'s manifest': {'docs/acceptance/fix-rounds/GRS-105-1.json': '{}'},
        }
        for label, files in cases.items():
            with self.subTest(bypass=label):
                self.reset()
                self.fix_round(files)
                self.assertRefused(self.guard(code=1), 'docs-only', next(iter(files)))

    def test_a_runtime_change_anywhere_in_the_round_refuses(self):
        cases = {
            'in an earlier commit of the round': lambda: (self.write('src/app.ts', 'export const value = 3;\n'),
                                                          self.commit('runtime first'), self.fix_round()),
            'a deleted module': lambda: ((self.repo / 'src/app.ts').unlink(), self.fix_round()),
            'an executable Markdown file': lambda: (self.fix_round({'docs/run.md': '# Run\n'}),
                                                    (self.repo / 'docs/run.md').chmod(0o755), self.commit('make it executable')),
            'a Markdown symlink': lambda: ((self.repo / 'docs').mkdir(exist_ok=True),
                                           (self.repo / 'docs/link.md').symlink_to('../src/app.ts'), self.fix_round()),
        }
        paths = {'in an earlier commit of the round': 'src/app.ts', 'a deleted module': 'src/app.ts',
                 'an executable Markdown file': 'docs/run.md', 'a Markdown symlink': 'docs/link.md'}
        for label, build in cases.items():
            with self.subTest(bypass=label):
                self.reset()
                build()
                self.assertRefused(self.guard(code=1), 'docs-only', paths[label])

    def test_a_test_manifest_still_needs_its_named_tests(self):
        # preserved: without a declaration, an empty or missing tests list and a missing manifest fail closed
        for label, manifest in {'tests: []': {'noTests': DROP}, 'no tests field': {'noTests': DROP, 'tests': DROP}}.items():
            with self.subTest(manifest=label):
                self.reset()
                self.fix_round(**manifest)
                self.assertRefused(self.guard(code=1), 'findings.tests must be a nonempty list')
        self.reset()
        self.write('docs/guide.md', '# Guide\n\nThe corrected step.\n')
        self.commit('a docs fix round with no manifest')
        self.assertIn('no fix-round manifest', self.guard(code=1))


class IntoTheWave(DocsOnlyFixRound):
    """The GRS-153 shape: the base moves on and the branch merges it; then the ticket merges into its wave and the wave
    pull request into dev reruns every manifest at the wave head."""

    def test_the_wave_moving_on_is_the_base_s_change_and_a_branch_edit_after_it_is_not(self):
        self.fix_round()
        self.another_ticket()
        self.git('switch', '-q', BRANCH)
        head = self.merge(WAVE)
        self.guard()
        receipt = self.last_receipt()
        self.assertEqual((receipt['name'], receipt['result'], receipt['revision']['head']), ('test-guard', 'PASS', head))
        self.assertEqual(receipt['guard']['trustedBase'], self.git('rev-parse', WAVE))
        self.write('src/grs-105-other.ts', 'export const other = 2;\n')
        self.commit('a branch edit after the merge')
        self.assertIn('src/grs-105-other.ts', self.guard(code=1))

    def test_the_declaration_propagates_into_the_wave_pull_request(self):
        ticket = self.fix_round()
        self.git('switch', '-q', WAVE)
        self.merge(BRANCH)
        self.another_ticket()
        self.git('switch', '-q', 'dev')
        self.write('src/dev.ts', 'export const dev = 1;\n')
        self.commit('dev moves on')
        self.git('switch', '-q', WAVE)
        wave = self.merge('dev')
        self.guard(base='dev', branch=WAVE)
        receipt = self.last_receipt()
        self.assertEqual((receipt['name'], receipt['result'], receipt['revision']['head']), ('test-guard', 'PASS', wave))
        self.assertEqual(receipt['guard']['fixHead'], ticket)
        # judged as one branch, the later ticket's runtime and test changes are inside the declared range
        self.assertIn('src/grs-105-other.ts', self.guard(base='dev', branch='feature/grs-106-later', code=1))

    def test_a_ticket_that_merged_the_wave_propagates_too(self):
        self.another_ticket()
        self.git('switch', '-q', BRANCH)
        self.merge(WAVE)
        ticket = self.fix_round()
        self.git('switch', '-q', WAVE)
        self.merge(BRANCH)
        self.another_ticket('feature/grs-106-later')
        self.guard(base='dev', branch=WAVE)
        self.assertEqual(self.last_receipt()['guard']['fixHead'], ticket)

    def test_a_pull_request_fix_round_on_the_wave_propagates_beside_another_owner_s_round(self):
        # PRFIX: the reviewed commit is the wave head itself, and two owners fix in parallel
        self.git('switch', '-q', WAVE)
        self.merge(BRANCH)
        self.reviewed = self.git('rev-parse', 'HEAD')
        self.saved_review([])
        self.git('switch', '-q', '-c', 'feature/grs-149-prfix-90')
        prfix = self.fix_round()
        self.another_ticket('feature/grs-150-prfix-90', start=self.reviewed)
        self.merge('feature/grs-149-prfix-90')
        self.guard(base='dev', branch=WAVE)
        self.assertEqual(self.last_receipt()['guard']['fixHead'], prfix)

    def test_a_runtime_change_on_the_declared_line_still_refuses_at_the_wave(self):
        self.fix_round()
        self.write('src/app.ts', 'export const value = 3;\n')
        self.commit('a runtime change after the docs fix')
        self.git('switch', '-q', WAVE)
        self.merge(BRANCH)
        self.another_ticket()
        self.assertIn('src/app.ts', self.guard(base='dev', branch=WAVE, code=1))

    def test_a_manifest_changed_on_the_wave_after_its_merge_is_judged_whole(self):
        self.fix_round()
        self.git('switch', '-q', WAVE)
        self.merge(BRANCH)
        self.another_ticket()
        self.manifest(declaration=self.declaration(reason='M1 is a documentation finding, reworded on the wave.'))
        self.commit('the manifest edited on the wave')
        self.assertIn('src/grs-105-other.ts', self.guard(base='dev', branch=WAVE, code=1))

    def test_a_branch_that_merges_its_manifest_in_from_a_side_line_is_judged_whole(self):
        self.git('switch', '-q', '-c', 'side', self.reviewed)
        self.fix_round()
        self.git('switch', '-q', BRANCH)
        self.write('src/app.ts', 'export const value = 3;\n')
        self.commit('a runtime change on the branch itself')
        self.merge('side')
        self.assertIn('src/app.ts', self.guard(code=1))


class Approval(DocsOnlyFixRound):
    def test_a_declaration_receipt_approves_and_reads_back(self):
        self.record([])
        self.fix_round()
        receipt = self.strict()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve('--guard-receipt', receipt)
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        guard = json.loads(approved.read_text())['approval']['guard']
        self.assertEqual((guard['nothingToProtect'], guard['tests'], guard['noTests']['reviewSha']), (True, [], self.reviewed))
        self.cli('approval-check', '--unit', UNIT, '--sha', self.sha, '--approval-receipt', approved)

    def test_approval_needs_the_declaration_receipt_once_the_tree_holds_the_manifest(self):
        self.record([])
        self.fix_round()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn(self.path, self.approve(code=1))

    def test_approval_refuses_a_declaration_for_other_findings(self):
        self.record([])
        self.findings_sha = '1' * 64  # consistent in the manifest, but not the hash the ledger recorded
        self.fix_round()
        receipt = self.strict()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('findings', self.approve('--guard-receipt', receipt, code=1))

    def test_approval_refuses_the_wave_rerun_receipt(self):
        self.record([])
        self.fix_round()
        self.guard()
        receipt = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('--base', self.approve('--guard-receipt', receipt, code=1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
