"""Synthetic CLI acceptance tests for the unattended controls; no case data or network."""
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / 'scripts/agent-tools'


def without_exact(value, keep=()):
    """A receipt or ledger row as an older tool wrote it: every *Exact field dropped except those in keep."""
    if isinstance(value, dict):
        return {key: without_exact(item, keep) for key, item in value.items() if not key.endswith('Exact') or key in keep}
    if isinstance(value, list):
        return [without_exact(item, keep) for item in value]
    return value


class ControlCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='grs104-controls-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.repo = self.work / 'repo'
        self.repo.mkdir()
        self.receipts = self.work / 'receipts'
        self.env = {k: v for k, v in os.environ.items() if k not in ('CLEARCASE_BASE_REF', 'GIT_DIR', 'GIT_WORK_TREE')}
        self.env['CLEARCASE_RECEIPTS_DIR'] = str(self.receipts)
        self.git('init', '-q', '-b', 'dev')
        self.write('app.txt', 'before\n')
        self.commit('base')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=self.env, stderr=subprocess.STDOUT).decode().strip()

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def document(self, name, data):
        path = self.work / name
        path.write_text(json.dumps(data))
        return path

    def commit(self, name):
        self.git('add', '-A')
        self.git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-qm', name)
        return self.git('rev-parse', 'HEAD')

    def cli(self, command, *args, code=0):
        result = subprocess.run([str(TOOLS / command), '--root', str(self.repo), *map(str, args)], cwd=self.repo,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def last_receipt(self):
        return json.loads(sorted(self.receipts.glob('*/receipt.json'))[-1].read_text())


class TestWeakening(ControlCase):
    original = '''import { test, expect } from 'vitest';
 test('rejects stale evidence', () => {
   expect(validate('old')).toEqual(false);
   expect(validate('new')).toEqual(true);
 });
 test('other behavior', () => { expect(other()).toEqual(42); });
'''

    def prepare(self, after):
        self.write('tests/protected.test.ts', self.original)
        self.base = self.commit('reviewed tests')
        self.write('tests/protected.test.ts', after)
        self.write('app.txt', 'fixed\n')
        self.commit('fix')
        self.findings = self.document('findings.json', {'tests': [
            {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})

    def guard(self, code=0):
        return self.cli('test-guard', '--fix-base', self.base, '--findings', self.findings, code=code)

    def test_clean_fix_preserves_named_test(self):
        self.prepare(self.original + "test('new behavior', () => { expect(newValue()).toEqual(1); });\n")
        data = json.loads(self.findings.read_text())
        data['assertionCountReasons'] = {'tests/protected.test.ts': 'Reviewed addition of a new independent test'}
        self.findings.write_text(json.dumps(data))
        self.guard()
        self.assertEqual(self.last_receipt()['result'], 'PASS')

    def test_named_test_cannot_be_deleted_renamed_skipped_or_weakened(self):
        variants = {
            'deleted': self.original.replace(self.original[self.original.index(" test('rejects"):self.original.index(" test('other")], ''),
            'renamed': self.original.replace('rejects stale evidence', 'accepts stale evidence'),
            'skip': self.original.replace("test('rejects", "test.skip('rejects"),
            'xit': self.original.replace("test('rejects", "xit('rejects"),
            'todo': self.original.replace("test('rejects", "test.todo('rejects"),
            'removed assertion': self.original.replace("   expect(validate('new')).toEqual(true);\n", ''),
            'loosened matcher': self.original.replace('.toEqual(false)', '.toBeDefined()'),
            'loosened value': self.original.replace("validate('old')", 'true'),
            'skipped parent': self.original.replace(" test('rejects", "describe.skip('hidden', () => { test('rejects").replace(" test('other", "}); test('other"),
        }
        for name, after in variants.items():
            with self.subTest(name=name):
                self.prepare(after)
                self.assertIn('test-guard: FAIL', self.guard(code=1))
                self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_assertion_drop_elsewhere_needs_recorded_reason(self):
        self.prepare(self.original.replace('expect(other()).toEqual(42);', 'other();'))
        self.assertIn('assertion count', self.guard(code=1))
        data = json.loads(self.findings.read_text())
        data['assertionCountReasons'] = {'tests/protected.test.ts': 'Duplicate coverage removed after review'}
        self.findings.write_text(json.dumps(data))
        self.guard()

    def test_hiding_named_test_in_unexecuted_statement_refuses(self):
        self.prepare(self.original.replace(" test('rejects", "if (false) { test('rejects").replace(" test('other", "} test('other"))
        self.guard(code=1)

    def test_receipt_refuses_guard_failure_before_command(self):
        self.prepare(self.original.replace('.toEqual(false)', '.toBeTruthy()'))
        marker = self.work / 'must-not-run'
        self.cli('receipt', '--name', 'fix-check', '--fix-base', self.base, '--findings', self.findings,
                 '--', 'touch', marker, code=1)
        self.assertFalse(marker.exists())

    def test_git_overrides_cannot_redirect_guard_away_from_receipt_repository(self):
        self.prepare(self.original)
        unchanged = self.work / 'unchanged'
        subprocess.run(['git', 'clone', '-q', str(self.repo), str(unchanged)], check=True)
        self.write('tests/protected.test.ts', self.original.replace('.toEqual(false)', '.toMatchObject(false)'))
        weakened = self.commit('weakened matcher')
        self.env.update(GIT_DIR=str(unchanged / '.git'), GIT_WORK_TREE=str(unchanged))
        self.guard(code=1)
        row = self.last_receipt()
        self.assertEqual(row['revision']['head'], weakened)
        self.assertEqual(row['result'], 'FAIL')

    def test_protected_dependency_closure_refuses_helper_fixture_and_control_flow_changes(self):
        variants = {
            'helper matcher': ('support/helper.ts', 'expect(value).toBeDefined();'),
            'helper early return': ('support/helper.ts', 'return; expect(value).toEqual(false);'),
            'helper conditional': ('support/helper.ts', 'if (false) { expect(value).toEqual(false); }'),
            'transitive fixture': ('support/fixture.ts', 'export const expected = true;'),
            'same-file helper': ('tests/protected.test.ts', 'function validate() { return true; }'),
        }
        for label, (file, change) in variants.items():
            with self.subTest(bypass=label):
                self.write('support/helper.ts', "import { expected } from './fixture.js'; export function check(value) { expect(value).toEqual(false); }")
                self.write('support/fixture.ts', 'export const expected = false;')
                original = "import { check } from '../support/helper.js';\n" + self.original + 'function validate() { return false; }'
                self.write('tests/protected.test.ts', original)
                self.base = self.commit('protected closure baseline')
                if file.endswith('helper.ts'):
                    change = "import { expected } from './fixture.js'; export function check(value) { " + change + ' }'
                if file.startswith('tests/'):
                    change = original.replace('function validate() { return false; }', change)
                self.write(file, change)
                self.commit('dependency bypass')
                self.findings = self.document('findings.json', {'tests': [
                    {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})
                self.guard(code=1)

    def test_symlinked_module_cannot_hide_protected_dependency_changes(self):
        self.write('support/real.ts', 'export const expected = false;')
        (self.repo / 'support/helper.ts').symlink_to('real.ts')
        self.write('tests/protected.test.ts', "import { expected } from '../support/helper';\n" + self.original)
        self.base = self.commit('symlink dependency baseline')
        self.write('support/real.ts', 'export const expected = true;')
        self.commit('change symlink target module')
        self.findings = self.document('findings.json', {'tests': [
            {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})
        self.guard(code=1)

    def test_explicit_exception_cannot_hide_new_dependency_control_flow(self):
        for body in ('return; expect(value).toEqual(false);', 'if (false) { expect(value).toEqual(false); }'):
            with self.subTest(body=body):
                self.write('support/helper.ts', 'export function check(value) { expect(value).toEqual(false); }')
                self.write('tests/protected.test.ts', "import { check } from '../support/helper';\n" + self.original)
                self.base = self.commit('helper baseline')
                self.write('support/helper.ts', 'export function check(value) { ' + body + ' }')
                self.commit('hide helper behind control flow')
                self.findings = self.document('findings.json', {'tests': [
                    {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}],
                    'assertionCountReasons': {'support/helper.ts': 'Claimed independent review'}})
                self.assertIn('control flow changed', self.guard(code=1))

    def test_resolver_configuration_cannot_swap_or_hide_dependency_closure(self):
        for variant in ('swapped paths', 'extended config'):
            with self.subTest(bypass=variant):
                self.write('support/false.ts', 'export const expected = false;')
                self.write('support/true.ts', 'export const expected = true;')
                config = {'compilerOptions': {'baseUrl': '.', 'paths': {
                    'first': ['support/false.ts'], 'second': ['support/true.ts']}}}
                if variant == 'extended config':
                    self.write('tsconfig.paths.json', json.dumps(config))
                    self.write('tsconfig.json', '{"extends":"./tsconfig.paths.json"}')
                else:
                    self.write('tsconfig.json', json.dumps(config))
                self.write('tests/protected.test.ts', "import { expected as first } from 'first'; import { expected as second } from 'second'; test('rejects stale evidence', () => { expect(first).toEqual(false); expect(second).toEqual(true); });")
                self.base = self.commit('reviewed alias closure')
                self.findings = self.document('findings.json', {'tests': [
                    {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})
                self.guard()
                if variant == 'extended config':
                    self.write('support/false.ts', 'export const expected = true;')
                else:
                    config['compilerOptions']['paths'] = {'first': ['support/true.ts'], 'second': ['support/false.ts']}
                    self.write('tsconfig.json', json.dumps(config))
                self.commit('resolver bypass')
                self.findings = self.document('findings.json', {'tests': [
                    {'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})
                self.guard(code=1)

    def test_bad_findings_or_missing_baseline_never_pass(self):
        self.prepare(self.original)
        self.findings.write_text('{}')
        self.guard(code=1)
        self.findings.write_text(json.dumps({'tests': [{'file': 'missing.test.ts', 'name': 'missing'}]}))
        self.guard(code=1)



class ApprovalLedger(ControlCase):
    def prepare(self, unresolved=None, command=None, inputs=()):
        self.sha = self.git('rev-parse', 'HEAD')
        options = [part for path in inputs for part in ('--input', path)]
        self.cli('receipt', '--name', 'tooling', *options, '--', *(command or ['true']))
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.review_index = getattr(self, 'review_index', 0) + 1
        self.findings = self.document(f'approval-findings-{self.review_index}.json', {
            'sha': self.sha, 'updatedAt': '2026-10-17T10:00:00+00:00',
            'unresolvedFindings': unresolved or []})
        self.review = self.document(f'review-{self.review_index}.json', {
            'schema': 'clearcase-review/1', 'sha': self.sha, 'verdict': 'PASS',
            'reviewer': 'fresh-reviewer', 'implementer': 'implementation-agent', 'fresh': True,
            'reviewedAt': '2026-10-17T11:00:00+00:00',
            'findingsSha256': hashlib.sha256(self.findings.read_bytes()).hexdigest(),
            'unresolvedFindings': unresolved or [], 'requiredChecks': [{
                'name': 'tooling', 'execution': json.loads(self.check.read_text())['execution'],
                'inputs': json.loads(self.check.read_text())['inputs']}]})
        self.cli('review-record', '--unit', getattr(self, 'unit', 'GRS-104/implementation'), '--review', self.review, '--findings', self.findings)

    def approve(self, code=0):
        return self.cli('approve', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                        '--review', self.review, '--findings', self.findings,
                        '--check-receipt', self.check, '--approved-by', 'coordinator', code=code)

    def test_exact_review_checks_and_approval_form_a_ledger_row(self):
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve()
        row = self.last_receipt()
        self.assertEqual(row['approval']['state'], 'approved')
        self.assertEqual(row['approval']['sha'], self.sha)
        self.assertEqual(row['approval']['unresolvedFindings'], [{'id': 'L1', 'severity': 'low'}])
        self.assertTrue(row['inputs'])
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved)
        self.write('app.txt', 'later change\n')
        self.commit('later revision')
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.git('rev-parse', 'HEAD'),
                 '--approval-receipt', approved, code=1)

    def test_stale_or_failed_or_dirty_check_receipt_refuses(self):
        for field, value in [('head', '0' * 40), ('dirty', True), ('result', 'FAIL')]:
            with self.subTest(field=field):
                self.prepare()
                data = json.loads(self.check.read_text())
                (data['revision'] if field in ('head', 'dirty') else data)[field] = value
                self.check.write_text(json.dumps(data))
                self.approve(code=1)
                self.assertEqual(self.last_receipt()['approval']['state'], 'refuse')

    def test_dirty_tree_cannot_be_approved(self):
        self.prepare()
        self.write('app.txt', 'dirty\n')
        self.approve(code=1)
        self.assertEqual(self.last_receipt()['approval']['state'], 'refuse')

    def test_newer_findings_or_changed_findings_refuse(self):
        self.prepare()
        os.utime(self.findings, ns=(self.review.stat().st_mtime_ns + 1_000_000,) * 2)
        self.approve(code=1)
        self.prepare()
        data = json.loads(self.findings.read_text())
        data['updatedAt'] = '2026-10-17T12:00:00+00:00'
        self.findings.write_text(json.dumps(data))
        self.approve(code=1)

    def test_unresolved_blocker_or_unknown_severity_cannot_approve(self):
        for severity in ('high', 'medium', 'P0', 'P1', 'unknown'):
            with self.subTest(severity=severity):
                self.prepare([{'id': 'F1', 'severity': severity}])
                self.approve(code=1)

    def test_worker_cannot_downgrade_recorded_original_severity(self):
        self.prepare([{'id': 'F1', 'severity': 'high'}])
        self.approve(code=1)
        findings = json.loads(self.findings.read_text())
        findings['unresolvedFindings'][0]['severity'] = 'low'
        self.findings.write_text(json.dumps(findings))
        review = json.loads(self.review.read_text())
        review['unresolvedFindings'] = findings['unresolvedFindings']
        review['findingsSha256'] = hashlib.sha256(self.findings.read_bytes()).hexdigest()
        self.review.write_text(json.dumps(review))
        self.approve(code=1)

    def superseded_review(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        previous = (self.review, self.findings, self.check)
        self.prepare([{'id': 'F1', 'severity': 'high'}])
        self.approve(code=1)
        self.review, self.findings, self.check = previous
        return approved

    def test_superseded_review_cannot_be_resurrected_at_approval(self):
        self.superseded_review()
        self.approve(code=1)

    def test_superseded_review_cannot_be_resurrected_at_readback(self):
        approved = self.superseded_review()
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)

    def test_review_and_required_checks_must_be_complete(self):
        self.prepare()
        data = json.loads(self.review.read_text())
        data['requiredChecks'] = ['tooling', 'unit']
        self.review.write_text(json.dumps(data))
        self.approve(code=1)
        data['requiredChecks'] = []
        self.review.write_text(json.dumps(data))
        self.approve(code=1)
        data['requiredChecks'] = ['tooling']
        data['fresh'] = False
        self.review.write_text(json.dumps(data))
        self.approve(code=1)

    def test_approval_readback_rechecks_input_identity(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.review.write_text(self.review.read_text() + ' ')
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)

    def test_changed_check_inputs_refuse_at_approval_and_readback(self):
        external = self.work / 'EXTERNAL_INPUT'
        external.write_text('PASS\n')
        command = ['grep', '-qx', 'PASS', str(external)]
        self.prepare(command=command, inputs=[external])
        external.write_text('FAIL\n')
        self.approve(code=1)
        external.write_text('PASS\n')
        self.prepare(command=command, inputs=[external])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        external.write_text('FAIL again\n')
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)

    def test_external_input_symlink_retarget_refuses_approval_and_readback(self):
        good, bad, link = [self.work / name for name in ('good', 'bad', 'EXTERNAL_INPUT')]
        good.write_text('PASS\n')
        bad.write_text('FAIL\n')
        link.symlink_to(good)
        command = ['grep', '-qx', 'PASS', str(link)]
        self.prepare(command=command, inputs=[link])
        link.unlink()
        link.symlink_to(bad)
        self.approve(code=1)
        link.unlink()
        link.symlink_to(good)
        self.prepare(command=command, inputs=[link])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        link.unlink()
        link.symlink_to(bad)
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)

    def test_true_cannot_satisfy_reviewed_tooling_command(self):
        self.prepare(command=['bash', '-c', ':'])
        self.cli('receipt', '--name', 'tooling', '--', 'true')
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.approve(code=1)

    def test_runtime_byte_changes_at_same_path_refuse_both_boundaries(self):
        shims = self.work / 'runtime'
        shims.mkdir()
        shim = shims / 'bun'
        shim.write_text('#!/bin/bash\nexec "' + shutil.which('bun') + '" "$@"\n')
        shim.chmod(0o755)
        self.env['PATH'] = str(shims) + os.pathsep + self.env['PATH']
        self.prepare()
        shim.write_text(shim.read_text() + '# bytes changed\n')
        self.approve(code=1)
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        shim.write_text(shim.read_text() + '# bytes changed again\n')
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)

    def approve_and_read_back_under_home(self, command):
        """PR #62 (dianbrown, P1): a PASS receipt whose argv names a path under HOME approves and reads back."""
        home = self.work / 'reviewer-home'
        home.mkdir(exist_ok=True)
        self.env['HOME'] = str(home)
        self.prepare(command=[word.replace('$HOME', str(home)) for word in command])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved)

    def test_embedded_home_path_in_an_option_argument_approves_and_reads_back(self):
        self.approve_and_read_back_under_home(['bash', '-c', ':', '--outputFile.json=$HOME/results.json'])

    def test_inline_snippet_with_a_home_path_approves_and_reads_back(self):
        self.approve_and_read_back_under_home(['python3', '-I', '-c', "path = '$HOME/out.json'; assert path"])
        self.approve_and_read_back_under_home(['bash', '-c', 'test -n "$HOME/out.json"'])

    def test_backslashes_and_a_literal_marker_in_argv_survive_the_exact_record(self):
        self.approve_and_read_back_under_home(['bash', '-c', ':', r'a\h$HOME\\b', '$HOME/x:$HOME/y'])

    def test_receipt_without_the_exact_execution_record_refuses_clearly(self):
        self.prepare()
        for document in (self.check, self.review):
            data = json.loads(document.read_text())
            execution = data['execution'] if document == self.check else data['requiredChecks'][0]['execution']
            del execution['argvExact'], execution['cwdExact']
            document.write_text(json.dumps(data))
        self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', self.review, '--findings', self.findings)
        self.assertIn('predates the exact execution record', self.approve(code=1))

    def test_input_path_with_the_home_text_beside_a_directory_name_approves_and_reads_back(self):
        self.env['HOME'] = '/inner'
        (self.work / 'inner').mkdir()
        (self.work / 'inner' / 'evidence.txt').write_text('evidence\n')
        self.prepare(inputs=[str(self.work / 'inner' / 'evidence.txt')])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved)

    def test_home_text_in_printed_argv_words_never_reaches_the_receipt(self):
        """PR #62 re-check (M1): redaction is display-only, so -I$HOME/inc and file://$HOME/f print as ~ and still approve."""
        home = self.work / 'reviewer-home'
        home.mkdir(exist_ok=True)
        self.env['HOME'] = str(home)
        self.prepare(command=['bash', '-c', ':', f'-I{home}/inc', f'file://{home}/f', f'--out{home}/x'])
        execution = json.loads(self.check.read_text())['execution']
        for field in ('argv', 'commandLine', 'command'):
            data = json.loads(self.check.read_text())
            printed = json.dumps(data.get(field, execution.get(field)))
            self.assertNotIn(str(home), printed, field)
        self.assertIn('-I~/inc', execution['argv'])
        self.assertIn('file://~/f', execution['argv'])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved)

    def test_input_path_with_a_space_or_colon_before_the_home_text_approves_and_reads_back(self):
        home = self.work / 'reviewer-home'
        home.mkdir(exist_ok=True)
        self.env['HOME'] = str(home)
        for index, separator in enumerate(('x:', 'a ')):
            evidence = Path(f'{self.work}/{separator}{home}/f{index}.txt')
            evidence.parent.mkdir(parents=True, exist_ok=True)
            evidence.write_text('evidence\n')
            with self.subTest(separator=separator):
                self.prepare(inputs=[str(evidence)])
                self.approve()
                approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
                self.assertNotIn(str(home), approved.read_text())
                self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                         '--approval-receipt', approved)

    def test_receipt_without_the_exact_input_path_refuses_clearly(self):
        evidence = self.work / 'evidence.txt'
        evidence.write_text('evidence\n')
        self.prepare(inputs=[str(evidence)])
        for document in (self.check, self.review):
            data = json.loads(document.read_text())
            for row in data['inputs'] if document == self.check else data['requiredChecks'][0]['inputs']:
                del row['pathExact']
            document.write_text(json.dumps(data))
        self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', self.review, '--findings', self.findings)
        self.assertIn('predates the exact input record', self.approve(code=1))

    def test_changed_argv_with_a_home_path_still_refuses(self):
        home = self.work / 'reviewer-home'
        home.mkdir(exist_ok=True)
        self.env['HOME'] = str(home)
        self.prepare(command=['bash', '-c', ':', f'--outputFile.json={home}/results.json'])
        self.cli('receipt', '--name', 'tooling', '--', 'bash', '-c', ':', f'--outputFile.json={home}/other.json')
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.approve(code=1)

    def test_review_findings_and_receipts_beside_a_home_named_directory_approve_and_read_back(self):
        """PR #62 re-check r2 (M1): with HOME=/inner, .../x/inner/f displays as .../x~/f, which is not a path. The
        review, findings, check receipt and its stdout and stderr are read back from their exact records."""
        self.env['HOME'] = '/inner'
        self.receipts = self.work / 'inner' / 'receipts'
        self.env['CLEARCASE_RECEIPTS_DIR'] = str(self.receipts)
        self.prepare()
        for name in ('findings', 'review'):
            beside = self.work / 'inner' / getattr(self, name).name
            shutil.copy2(getattr(self, name), beside)
            setattr(self, name, beside)
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertNotIn('/inner/', approved.read_text())
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved)

    def test_receipt_without_the_exact_input_realpath_refuses_clearly(self):
        """PR #62 re-check r2 (L1): the realpath check is never skipped; a row without realpathExact is refused."""
        evidence = self.work / 'evidence.txt'
        evidence.write_text('evidence\n')
        self.prepare(inputs=[str(evidence)])
        for document in (self.check, self.review):
            data = json.loads(document.read_text())
            for row in data['inputs'] if document == self.check else data['requiredChecks'][0]['inputs']:
                del row['realpathExact']
            document.write_text(json.dumps(data))
        self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', self.review, '--findings', self.findings)
        self.assertIn('predates the exact input record', self.approve(code=1))

    def rewrite_approval(self, approved, change):
        """Rewrite an approval receipt and its ledger event alike and rehash the chain, as an older tool wrote both."""
        receipt = change(json.loads(approved.read_text()))
        log, previous, events = self.receipts / 'events.jsonl', '0' * 64, []
        for line in log.read_text().splitlines():
            event = json.loads(line)
            matched = event.pop('hash') == receipt['approvalEvent']
            if matched:
                event['payload'].update(row=receipt['approval'], inputs=receipt['inputs'])
            event['previous'] = previous
            previous = hashlib.sha256(json.dumps(event, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            events.append({**event, 'hash': previous})
            if matched:
                receipt['approvalEvent'] = previous
        log.write_text(''.join(json.dumps(event, sort_keys=True) + '\n' for event in events))
        (self.receipts / 'events.tip').write_text(json.dumps({'sequence': len(events), 'hash': previous}))
        approved.write_text(json.dumps(receipt, indent=2) + '\n')

    def test_older_ledger_rows_and_receipts_refuse_clearly(self):
        """PR #62 re-check r2 (L2): a row or receipt without the exact records is refused with a clear message at
        approval-check and approve, never read back from its display form."""
        self.prepare()
        older = {
            'an approval row without its exact paths': lambda receipt: {**receipt, 'approval': without_exact(
                receipt['approval'], keep=('argvExact', 'cwdExact', 'pathExact', 'realpathExact'))},
            'an f1266f6 approval receipt': without_exact,
        }
        for label, change in older.items():
            with self.subTest(label):
                self.approve()
                approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
                self.rewrite_approval(approved, change)
                self.assertIn('predates the exact', self.cli(
                    'approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                    '--approval-receipt', approved, code=1))
        with self.subTest('f1266f6 check receipt'):
            for document in (self.check, self.review):
                document.write_text(json.dumps(without_exact(json.loads(document.read_text()))))
            self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', self.review, '--findings', self.findings)
            self.assertIn('predates the exact', self.approve(code=1))

    def test_a_check_receipt_from_a_checkout_that_displays_alike_refuses(self):
        """Revision identity is compared exactly: with HOME=/inner, .../x/inner/repo and a literal .../x~/repo
        display alike, but a check run in one is no evidence for the other."""
        self.env['HOME'] = '/inner'
        twin = Path(f'{self.work}~') / 'repo'
        self.addCleanup(shutil.rmtree, twin.parent, True)
        for checkout in (self.work / 'inner' / 'repo', twin):
            subprocess.check_call(['git', 'clone', '-q', str(self.repo), str(checkout)], env=self.env)
        self.repo = self.work / 'inner' / 'repo'
        self.prepare()
        self.repo = twin
        self.assertIn('revision mismatch', self.approve(code=1))

    def test_name_only_cannot_substitute_another_command(self):
        self.prepare()
        self.cli('receipt', '--name', 'tooling', '--', 'bash', '-c', 'true')
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.approve(code=1)

    def test_path_shim_cannot_stand_in_for_reviewed_bun(self):
        command = ['bun', '-e', "console.log('checks ran')"]
        self.prepare(command=command)
        shims = self.work / 'shims'
        shims.mkdir()
        shim = shims / 'bun'
        shim.write_text('#!/bin/bash\nif [ "$1" = --version ]; then echo 1.4.2; fi\nexit 0\n')
        shim.chmod(0o755)
        self.env['CLEARCASE_BUN'] = shutil.which('bun')
        self.env['PATH'] = str(shims) + os.pathsep + self.env['PATH']
        self.cli('receipt', '--name', 'tooling', '--tool', 'bun', '--', *command)
        self.check = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.approve(code=1)

    def test_environment_and_runtime_changes_refuse_at_both_approval_boundaries(self):
        for key in ('TMPDIR', 'CLEARCASE_TEST_MODE'):
            with self.subTest(environment=key):
                self.prepare()
                self.env[key] = str(self.work)
                self.approve(code=1)
                self.env.pop(key)
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.env['CLEARCASE_TEST_MODE'] = 'skip-checks'
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                 '--approval-receipt', approved, code=1)


class ModelSheet(ControlCase):
    def setUp(self):
        super().setUp()
        self.plugin_home = self.work / 'home'
        helper = TOOLS.parents[1] / 'tests/agent-tools/make_plugin.py'
        subprocess.run(['python3', '-I', str(helper), str(self.plugin_home), '2.0.0-rc.5'], check=True)
        self.env['HOME'] = str(self.plugin_home)
        self.env.pop('T3_PSTACK_ROOT', None)
        self.plugin = self.plugin_home / '.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.5'
        fixture = TOOLS.parents[1] / 'tests/agent-tools/fixtures/pstack'
        shutil.copytree(fixture / 'skills', self.plugin / 'skills', dirs_exist_ok=True)
        shutil.copy2(fixture / 'models.json', self.plugin / 'models.json')
        self.sheet = self.work / 'models.md'
        self.sheet.write_text('feature, refactoring: claudeAgent/claude-opus-5-5 effort=high\n')
        def model(name, option):
            return {'id': name, 'options': [{'id': option, 'type': 'enum', 'options': [
                {'id': 'high'}, {'id': 'xhigh'}, {'id': 'max'}]}]}
        self.catalog = self.document('catalog.json', {
            'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'providers': [
                {'providerInstanceId': 'claudeAgent', 'canRunChildTask': True, 'models': [
                    model('claude-opus-5-5', 'effort'), model('claude-fable-5-1', 'effort')]},
                {'providerInstanceId': 'codex', 'canRunChildTask': True, 'models': [model('gpt-6.1-sol', 'reasoningEffort')]},
                {'providerInstanceId': 'grok', 'canRunChildTask': True, 'models': [model('grok-4.7', 'reasoningEffort')]},
                {'providerInstanceId': 'ultracode', 'canRunChildTask': True, 'models': [model('ultracode', 'effort')]}]})

    def verify_sheet(self, code=0):
        return self.cli('verify', 'models', '--model-sheet', self.sheet, '--catalog', self.catalog, code=code)

    def test_positive_sheet_uses_canonical_validator_and_is_unchanged(self):
        before = self.sheet.read_bytes()
        self.assertIn('model-sheet: PASS', self.verify_sheet())
        self.assertEqual(self.sheet.read_bytes(), before)
        self.assertEqual(self.last_receipt()['result'], 'PASS')
        self.assertTrue(any('t3-sheet.mjs' in i['path'] for i in self.last_receipt()['inputs']))

    def test_missing_sheet_is_clear_failure(self):
        self.sheet.unlink()
        self.assertIn('model sheet', self.verify_sheet(code=1))
        self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_missing_catalogue_model_fails_clearly(self):
        self.sheet.write_text('feature, refactoring: claudeAgent/missing-model effort=high\n')
        self.assertIn('missing-model', self.verify_sheet(code=1))

    def test_max_and_ultracode_refuse_even_if_catalogue_allows(self):
        for entry in ('claudeAgent/claude-opus-5-5 effort=max', 'ultracode/ultracode effort=high',
                      'codex/gpt-6.1-sol reasoningEffort=max'):
            with self.subTest(entry=entry):
                self.sheet.write_text('feature, refactoring: ' + entry + '\n')
                self.verify_sheet(code=1)

    def test_offset_free_catalogue_timestamp_refuses(self):
        data = json.loads(self.catalog.read_text())
        data['capturedAt'] = datetime.datetime.now().isoformat()
        self.catalog.write_text(json.dumps(data))
        self.assertIn('catalogue', self.verify_sheet(code=1))

    def test_stale_catalogue_refuses(self):
        data = json.loads(self.catalog.read_text())
        data['capturedAt'] = '2000-01-01T00:00:00+00:00'
        self.catalog.write_text(json.dumps(data))
        self.assertIn('catalogue', self.verify_sheet(code=1))


class DispatchBookkeeping(ControlCase):
    def setUp(self):
        super().setUp()
        self.deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()

    def dispatch(self, phase, *args, code=0, task='task-one'):
        return self.cli('dispatch', '--unit', 'GRS-104/implementation', '--phase', phase,
                        '--task-id', task, *args, code=code)

    def initial(self):
        self.dispatch('initial', '--deadline', self.deadline)

    def test_counts_and_deadline_survive_task_rename_revision_and_restart(self):
        self.initial()
        self.dispatch('fix')
        self.dispatch('recheck', task='new-task-name')
        self.write('app.txt', 'next revision\n')
        self.commit('fixed revision')
        self.dispatch('escalation', task='another-task-name')
        row = self.last_receipt()['dispatch']
        self.assertEqual(row['counts'], {'initial': 1, 'fix': 1, 'recheck': 1, 'escalation': 1, 'infra-retry': 0})
        self.assertEqual(row['deadline'], self.deadline)
        self.assertEqual(row['deadlines']['initial'], self.deadline)
        self.assertTrue(row['attemptDeadline'])
        self.dispatch('fix', task='renamed-again', code=1)
        row = self.last_receipt()['dispatch']
        self.assertEqual(row['outcome'], 'refuse')
        self.assertEqual(row['counts']['fix'], 1)
        self.assertFalse(row['dispatchPerformed'])

    def test_moving_checkout_cannot_reset_original_unit_in_same_store(self):
        self.initial()
        self.dispatch('fix')
        relocated = self.work / 'relocated'
        subprocess.run(['git', 'clone', '-q', '--local', str(self.repo), str(relocated)], check=True)
        self.dispatch('fix', '--root', relocated, code=1)
        self.assertEqual(self.last_receipt()['dispatch']['counts']['fix'], 1)
        self.assertEqual(self.last_receipt()['dispatch']['deadline'], self.deadline)

    def test_concurrent_reservations_only_consume_one_fix_attempt(self):
        self.initial()
        args = [str(TOOLS / 'dispatch'), '--root', str(self.repo), '--unit', 'GRS-104/implementation',
                '--phase', 'fix', '--task-id', 'simultaneous']
        children = [subprocess.Popen(args, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        for child in children:
            child.communicate(timeout=15)
        self.assertEqual(sorted(child.returncode for child in children), [0, 1])

    def test_each_bounded_phase_and_infrastructure_retry_refuses_repeat(self):
        self.initial()
        self.dispatch('fix')
        self.dispatch('fix', code=1)
        self.dispatch('recheck')
        self.dispatch('recheck', code=1)
        self.dispatch('infra-retry')
        self.dispatch('infra-retry', code=1)
        self.dispatch('initial', '--deadline', self.deadline, code=1)

    def test_deadline_is_required_bounded_and_cannot_be_extended(self):
        self.dispatch('initial', code=1)
        self.dispatch('initial', '--deadline', '2000-01-01T00:00:00+00:00', code=1)
        too_late = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=3)).isoformat()
        self.dispatch('initial', '--deadline', too_late, code=1)
        self.initial()
        self.dispatch('fix', '--deadline', too_late, code=1)
        self.assertEqual(self.last_receipt()['dispatch']['deadline'], self.deadline)

    def test_expired_deadline_refuses_next_attempt_and_keeps_cancellation(self):
        soon = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=0.5)).isoformat()
        self.dispatch('initial', '--deadline', soon)
        time.sleep(0.6)
        self.dispatch('fix', '--deadline', soon, code=1)
        self.dispatch('cancel', '--cancel-outcome', 'confirmed', '--reason', 'Deadline expired')
        row = self.last_receipt()['dispatch']
        self.assertEqual(row['outcome'], 'cancelled')
        self.assertEqual(row['cancellation']['reason'], 'Deadline expired')
        self.assertEqual(row['counts']['fix'], 0)
        self.dispatch('fix', code=1)

    def test_each_attempt_gets_its_own_bounded_deadline(self):
        soon = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=1)).isoformat()
        self.dispatch('initial', '--deadline', soon)
        time.sleep(1.2)  # a fix normally starts after the initial attempt's window has closed
        self.dispatch('fix')
        row = self.last_receipt()['dispatch']
        self.assertEqual(row['outcome'], 'recorded')
        self.assertEqual(row['deadlines']['initial'], soon)
        self.assertGreater(datetime.datetime.fromisoformat(row['attemptDeadline']), datetime.datetime.now(datetime.timezone.utc))
        too_late = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=3)).isoformat()
        past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).isoformat()
        self.dispatch('recheck', '--deadline', too_late, code=1)
        self.dispatch('recheck', '--deadline', past, code=1)
        mine = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=40)).isoformat()
        self.dispatch('recheck', '--deadline', mine)
        self.assertEqual(self.last_receipt()['dispatch']['attemptDeadline'], mine)
        self.dispatch('recheck', code=1)

    def test_failed_cancellation_is_recorded_and_stops_attempts(self):
        self.initial()
        self.dispatch('cancel', '--cancel-outcome', 'failed', '--reason', 'Launcher could not confirm stop', code=1)
        row = self.last_receipt()['dispatch']
        self.assertEqual(row['outcome'], 'cancellation-failed')
        self.dispatch('fix', code=1)

    def test_same_failure_twice_needs_a_new_diagnosis(self):
        self.initial()
        self.dispatch('fix', '--failure', 'same-failure', '--diagnosis', 'first diagnosis')
        self.dispatch('recheck', '--failure', 'same-failure', '--diagnosis', 'first diagnosis', code=1)
        self.dispatch('recheck', '--failure', 'same-failure', '--diagnosis', 'new diagnosis')

    def test_same_failure_naming_a_home_path_twice_needs_a_new_diagnosis(self):
        """The stored failure and diagnosis are compared from their exact record; displayed, a path under HOME is ~."""
        self.env['HOME'] = str(self.work)
        failure, diagnosis = f'fails at {self.work}/repo/app.txt', f'stale fixture under {self.work}/fixtures'
        self.initial()
        self.dispatch('fix', '--failure', failure, '--diagnosis', diagnosis)
        self.assertNotIn(str(self.work), json.dumps(self.last_receipt()))
        self.dispatch('recheck', '--failure', failure, '--diagnosis', diagnosis, code=1)
        self.dispatch('recheck', '--failure', failure, '--diagnosis', f'{diagnosis}, read again')

    def test_a_home_that_redaction_would_take_out_of_a_stored_row_refuses_or_is_not_redacted(self):
        """An absolute HOME can only reach a unit's /implementation or /review suffix, so those refuse; a relative
        HOME is not a home directory and redacts nothing, so a stored outcome such as recorded stays itself."""
        self.env['HOME'] = '/implementation'
        self.assertIn('would redact the unit', self.dispatch('initial', '--deadline', self.deadline, code=1))
        self.env['HOME'] = 'recorded'
        self.initial()
        self.dispatch('fix')
        self.dispatch('fix', code=1)

    def test_worker_cannot_reset_stored_fix_counts(self):
        self.initial()
        self.dispatch('fix')
        for path in self.receipts.glob('*/receipt.json'):
            data = json.loads(path.read_text())
            data['dispatch']['counts']['fix'] = 0
            path.write_text(json.dumps(data))
        self.dispatch('fix', code=1)

    def test_removing_attempt_receipt_cannot_reset_budget(self):
        self.initial()
        self.dispatch('fix')
        latest = sorted(self.receipts.glob('*/receipt.json'))[-1]
        latest.unlink()
        self.dispatch('fix', code=1)

    def test_noncanonical_linear_spelling_cannot_reset_unit_deadline_or_attempts(self):
        self.initial()
        self.dispatch('fix')
        later = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=80)).isoformat()
        for unit in ('GRS-0104/implementation', 'grs-104/implementation', 'GrS-00104/implementation'):
            with self.subTest(unit=unit):
                self.cli('dispatch', '--unit', unit, '--phase', 'initial', '--task-id', 'renamed',
                         '--deadline', later, code=1)
        self.dispatch('fix', code=1)

    def test_truncated_event_history_refuses(self):
        self.initial()
        self.dispatch('fix')
        log = self.receipts / 'events.jsonl'
        log.write_text(log.read_text().splitlines()[0] + '\n')
        self.dispatch('recheck', code=1)

    def test_out_of_order_stage_and_corrupt_store_refuse(self):
        self.dispatch('recheck', code=1)
        self.initial()
        damaged = sorted(self.receipts.glob('*/receipt.json'))[-1]
        damaged.write_text('not JSON')
        self.dispatch('fix', code=1)


class LegacyRegistry(ControlCase):
    def setUp(self):
        super().setUp()
        home = self.work / 'home'
        helper = TOOLS.parents[1] / 'tests/agent-tools/make_plugin.py'
        subprocess.run(['python3', '-I', str(helper), str(home), '2.0.0-rc.5'], check=True)
        plugin = home / '.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.5'
        self.skills = home / '.agents/skills'
        shutil.copytree(plugin / 'skills', self.skills)
        shutil.rmtree(home / '.claude/plugins/cache')
        self.registry = home / '.claude/plugins/installed_plugins.json'
        self.registry.write_text('{"plugins":{}}')
        self.env['HOME'] = str(home)
        self.env.pop('T3_PSTACK_ROOT', None)

    def test_existing_legacy_registry_is_fingerprinted(self):
        self.cli('verify', 'pstack', '--skills-dir', self.skills)
        paths = [row['path'] for row in self.last_receipt()['inputs']]
        self.assertTrue(any(path.endswith('/installed_plugins.json') for path in paths))

    def test_changed_legacy_registry_fails_receipt(self):
        wrapper = self.work / 'node-wrapper'
        # Mutate only when the real checker runs, after discovery and version probing.
        wrapper.write_text('#!/bin/bash\nif [ "$1" != "--version" ]; then printf " " >>"$LEGACY_REGISTRY"; fi\nexec "' + shutil.which('node') + '" "$@"\n')
        wrapper.chmod(0o755)
        self.env['CLEARCASE_NODE'] = str(wrapper)
        self.env['LEGACY_REGISTRY'] = str(self.registry)
        plan = TOOLS.parents[1] / 'tests/agent-tools/fixtures/plans/valid.md'
        self.assertIn('input changed during the run', self.cli('verify', 'plan-format', '--skills-dir', self.skills,
                      '--plan', plan, code=1))
        self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_absent_legacy_registry_keeps_positive_fallback(self):
        self.registry.unlink()
        self.cli('verify', 'pstack', '--skills-dir', self.skills)
        self.assertEqual(self.last_receipt()['result'], 'PASS')


class RetainedLedger(ControlCase):
    """The ledger store sits outside the checked checkout, and every approval is an event in its append-only log."""
    prepare = ApprovalLedger.prepare
    approve = ApprovalLedger.approve

    def events(self, store=None):
        return [json.loads(line) for line in ((store or self.receipts) / 'events.jsonl').read_text().splitlines()]

    def readback(self, receipt, code=0):
        return self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha,
                        '--approval-receipt', receipt, code=code)

    def test_store_inside_the_checked_checkout_refuses(self):
        sha = self.git('rev-parse', 'HEAD')
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        commands = [
            ['dispatch', '--unit', 'GRS-104/implementation', '--phase', 'initial', '--task-id', 't', '--deadline', deadline],
            ['review-record', '--unit', 'GRS-104/implementation', '--review', 'r.json', '--findings', 'f.json'],
            ['approve', '--unit', 'GRS-104/implementation', '--sha', sha, '--review', 'r.json', '--findings', 'f.json',
             '--check-receipt', 'c.json', '--approved-by', 'coordinator'],
            ['approval-check', '--unit', 'GRS-104/implementation', '--sha', sha, '--approval-receipt', 'a.json']]
        for variable, value in [('CLEARCASE_LEDGER_DIR', self.repo / '.local/ledger'),
                                ('CLEARCASE_RECEIPTS_DIR', self.repo / '.local/agent-receipts')]:
            self.env[variable] = str(value)
            for command in commands:
                with self.subTest(variable=variable, command=command[0]):
                    self.assertIn('outside the checkout', self.cli(*command, code=1))
            self.env.pop('CLEARCASE_LEDGER_DIR', None)
        self.env['CLEARCASE_RECEIPTS_DIR'] = str(self.receipts)
        self.assertIn('outside the checkout', self.cli(*commands[0], '--ledger', self.repo, code=1))
        self.assertFalse((self.repo / '.local').exists())
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_store_elsewhere_in_the_checkout_of_a_subdirectory_root_refuses(self):
        (self.repo / 'sub').mkdir()
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        self.assertIn('outside the checkout', self.cli(
            'dispatch', '--unit', 'GRS-104/implementation', '--phase', 'initial', '--task-id', 't', '--deadline', deadline,
            '--root', self.repo / 'sub', '--ledger', self.repo / 'ledger', code=1))
        self.assertFalse((self.repo / 'ledger').exists())

    def test_ledger_dir_holds_review_and_approval_events_apart_from_check_receipts(self):
        ledger = self.work / 'ledger'
        self.env['CLEARCASE_LEDGER_DIR'] = str(ledger)
        self.prepare()
        self.approve()
        self.assertEqual([event['kind'] for event in self.events(ledger)], ['review', 'approval'])
        self.assertFalse((self.receipts / 'events.jsonl').exists())
        approved = sorted(ledger.glob('*/receipt.json'))[-1]
        self.assertEqual(json.loads(approved.read_text())['name'], 'approve')
        self.readback(approved)

    def test_approval_row_is_an_append_only_event(self):
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        receipt = json.loads(approved.read_text())
        event = [event for event in self.events() if event['kind'] == 'approval'][-1]
        self.assertEqual(event['hash'], receipt['approvalEvent'])
        self.assertEqual(event['payload']['row'], receipt['approval'])
        self.assertEqual(event['payload']['inputs'], receipt['inputs'])
        self.readback(approved)

    def test_refused_approval_appends_no_approval_event(self):
        self.prepare([{'id': 'H1', 'severity': 'high'}])
        self.approve(code=1)
        self.assertEqual([event['kind'] for event in self.events()], ['review'])

    def test_edited_approval_receipt_refuses_readback(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        data = json.loads(approved.read_text())
        data['approval']['approvedBy'] = 'implementation-agent'
        approved.write_text(json.dumps(data))
        self.readback(approved, code=1)

    def test_copied_approval_receipt_is_not_the_ledger_row(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        copy = self.work / 'copied-approval' / 'receipt.json'
        copy.parent.mkdir()
        shutil.copy(approved, copy)
        self.readback(copy, code=1)

    def test_rewritten_log_without_the_approval_event_refuses_readback(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        first = (self.receipts / 'events.jsonl').read_text().splitlines()[0]
        (self.receipts / 'events.jsonl').write_text(first + '\n')
        (self.receipts / 'events.tip').write_text(json.dumps({'sequence': 1, 'hash': json.loads(first)['hash']}))
        self.readback(approved, code=1)


class PrePush(ControlCase):
    """The repo-side half of the coordinator's pre-push hook: a feature push needs its ledger approval."""
    prepare = ApprovalLedger.prepare
    approve = ApprovalLedger.approve

    def push(self, sha, ref='refs/heads/feature/grs-104-tooling', code=0):
        result = subprocess.run([str(TOOLS / 'pre-push'), '--root', str(self.repo), 'origin', 'git@example.invalid:x.git'],
                                input=f'refs/heads/local {sha} {ref} {"0" * 40}\n', cwd=self.repo, env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_feature_push_needs_an_approved_row_for_the_exact_sha(self):
        self.prepare()
        self.assertIn('BLOCKED', self.push(self.sha, code=1))
        self.approve()
        self.push(self.sha)
        self.assertEqual(self.last_receipt()['name'], 'approval-check')
        self.assertEqual(self.last_receipt()['result'], 'PASS')
        self.write('app.txt', 'unreviewed\n')
        self.assertIn('BLOCKED', self.push(self.commit('unreviewed change'), code=1))

    def test_approval_cannot_cover_another_issue_or_spelling(self):
        self.prepare()
        self.approve()
        for ref in ('refs/heads/feature/grs-105-other', 'refs/heads/feature/grs-0104-tooling',
                    'refs/heads/feature/tooling'):
            with self.subTest(ref=ref):
                self.assertIn('BLOCKED', self.push(self.sha, ref=ref, code=1))

    def test_edited_approval_refuses_push(self):
        self.prepare()
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        data = json.loads(approved.read_text())
        data['approval']['approvedBy'] = 'implementation-agent'
        approved.write_text(json.dumps(data))
        self.assertIn('BLOCKED', self.push(self.sha, code=1))

    def test_non_feature_refs_and_deletions_need_no_row(self):
        self.push(self.git('rev-parse', 'HEAD'), ref='refs/heads/wave/tooling')
        self.push('0' * 40)

    def test_store_inside_the_checkout_refuses_push(self):
        self.env['CLEARCASE_LEDGER_DIR'] = str(self.repo / '.local/ledger')
        self.assertIn('outside the checkout', self.push(self.git('rev-parse', 'HEAD'), code=1))


class FixRoundManifest(ControlCase):
    """CI's half of the test guard: a fix round's committed manifest runs the guard on the pull request's head."""
    original = TestWeakening.original
    path = 'docs/acceptance/fix-rounds/GRS-104-1.json'

    def fix_round(self, after, manifest=True, **overrides):
        self.pr_base = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', '-c', 'feature/grs-104-tooling')
        self.write('tests/protected.test.ts', self.original)
        self.base = self.commit('reviewed tests')
        self.write('tests/protected.test.ts', after)
        self.write('app.txt', 'fixed\n')
        if manifest:
            self.manifest(**overrides)
        return self.commit('fix round')

    def manifest(self, **overrides):
        self.write(self.path, json.dumps({
            'schema': 'clearcase-fix-round/1', 'unit': 'GRS-104/implementation', 'fixBase': self.base,
            'tests': [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}], **overrides}))

    def guard(self, code=0):
        return self.cli('fix-round-guard', '--base', 'dev', code=code)

    def test_no_manifest_has_nothing_to_protect(self):
        self.fix_round(self.original, manifest=False)
        self.assertIn('no fix-round manifest', self.guard())
        receipt = self.last_receipt()
        self.assertEqual((receipt['name'], receipt['result']), ('fix-round-guard', 'PASS'))
        self.assertTrue(receipt['guard']['nothingToProtect'])

    def test_manifest_runs_the_guard_at_head(self):
        head = self.fix_round(self.original)
        self.guard()
        receipt = self.last_receipt()
        self.assertEqual((receipt['name'], receipt['result'], receipt['revision']['head']), ('test-guard', 'PASS', head))
        self.assertTrue(any(row['path'].endswith(self.path) for row in receipt['inputs']))

    def test_manifest_refuses_a_weakened_named_test(self):
        self.fix_round(self.original.replace("toEqual(false)", "toBeDefined()"))
        self.guard(code=1)
        self.assertEqual(self.last_receipt()['result'], 'FAIL')

    def test_deleted_manifest_refuses(self):
        self.fix_round(self.original)
        self.git('branch', '-f', 'dev', 'HEAD')
        (self.repo / self.path).unlink()
        self.commit('drop the manifest')
        self.assertIn('deleted', self.guard(code=1))

    def test_malformed_manifest_refuses(self):
        self.fix_round(self.original)
        for overrides in ({'schema': 'clearcase-fix-round/0'}, {'fixBase': self.base[:12]}, {'fixBase': '0' * 40},
                          {'unit': 'GRS-0104/implementation'}, {'tests': []}):
            with self.subTest(overrides=overrides):
                self.manifest(**overrides)
                self.commit(f'manifest {sorted(overrides)}')
                self.guard(code=1)


class GuardCase(ControlCase):
    original = TestWeakening.original
    named = [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]

    def protect(self, files=None, test=None):
        self.write('app.txt', self.git('rev-list', '--count', 'HEAD') + '\n')  # every baseline is a new commit
        for name, text in (files or {}).items():
            self.write(name, text)
        self.write('tests/protected.test.ts', test or self.original)
        self.base = self.commit('reviewed')

    def guard(self, code=0, reasons=None):
        data = {'tests': self.named}
        if reasons:
            data['assertionCountReasons'] = reasons
        findings = self.document('findings.json', data)
        return self.cli('test-guard', '--fix-base', self.base, '--findings', findings, code=code)


class GuardClosure(GuardCase):
    """H2/H3: the protected closure covers what decides whether a named test runs and what it reads, and nothing a
    legitimate fix has to change."""

    def test_runner_configuration_setup_files_and_test_scripts_are_protected(self):
        config = "export default { test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'] } };\n"
        package = {'name': 'x', 'version': '1.0.0', 'scripts': {'test': 'vitest run', 'start': 'node a.js'}}
        files = {'vitest.config.ts': config, 'tests/setup.ts': 'export {};\n', 'package.json': json.dumps(package)}
        variants = {
            'exclude': ('vitest.config.ts', config.replace("setupFiles", "exclude: ['tests/protected.test.ts'], setupFiles")),
            'setup file': ('tests/setup.ts', "import { beforeEach } from 'vitest'; beforeEach(() => {});\n"),
            'test script': ('package.json', json.dumps({**package, 'scripts': {**package['scripts'], 'test': 'vitest run --exclude tests/protected.test.ts'}})),
            'new config': ('vitest.workspace.ts', 'export default [];\n'),
        }
        for label, (file, text) in variants.items():
            with self.subTest(bypass=label):
                self.protect(files)
                self.write(file, text)
                self.commit(f'bypass {label}')
                self.assertIn('protected', self.guard(code=1))
        with self.subTest(control='unrelated package.json fields'):
            self.protect(files)
            self.write('package.json', json.dumps({**package, 'version': '1.0.1', 'scripts': {**package['scripts'], 'start': 'node b.js'}}))
            self.write('app.txt', 'fixed\n')
            self.commit('legitimate')
            self.guard()

    def test_fixtures_a_protected_test_reads_are_protected(self):
        reader = "import { readFileSync } from 'node:fs';\nconst data = readFileSync('tests/data/cases.txt', 'utf8');\n" + self.original
        joined = ("import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n"
                  "const data = readFileSync(join(__dirname, 'data/cases.txt'), 'utf8');\n" + self.original)
        for label, test in (('literal path', reader), ('dirname join', joined)):
            with self.subTest(read=label):
                self.protect({'tests/data/cases.txt': 'false\n'}, test)
                self.write('tests/data/cases.txt', 'true\n')
                self.commit('flip fixture')
                self.assertIn('protected', self.guard(code=1))
        with self.subTest('fixture directory'):
            self.protect({'tests/fixtures/other.json': '{"a":false}'})
            self.write('tests/fixtures/other.json', '{"a":true}')
            self.commit('flip a fixture file in the test tree')
            self.assertIn('protected', self.guard(code=1))
        with self.subTest(control='unread file'):
            self.protect({'tests/data/unread.txt': 'x\n', 'docs/note.md': 'x\n'})
            self.write('docs/note.md', 'changed\n')
            self.commit('legitimate')
            self.guard()

    def test_a_reason_cannot_excuse_a_loosened_matcher_a_new_mock_or_isolation(self):
        helper = "export function check(value) { expect(value).toEqual(false); }"
        head = "import { check } from '../support/helper';\n"
        reasons = {'support/helper.ts': 'Tidy', 'tests/protected.test.ts': 'Tidy'}
        with self.subTest(bypass='loosened helper matcher'):
            self.protect({'support/helper.ts': helper}, head + self.original)
            self.write('support/helper.ts', "export function check(value) { expect(value).toBeDefined(); }")
            self.commit('loosen')
            self.guard(code=1, reasons=reasons)
        with self.subTest(bypass='flipped helper constant'):
            self.protect({'support/helper.ts': 'export const expected = false;'}, "import { expected } from '../support/helper';\n" + self.original)
            self.write('support/helper.ts', 'export const expected = true;')
            self.commit('flip')
            self.guard(code=1, reasons=reasons)
        for label, extra in (('vi.mock', "vi.mock('../src/clamp');\n"), ('hook', "beforeEach(() => { reset(); });\n"),
                             ('only', "test.only('added', () => { expect(1).toEqual(1); });\n"),
                             ('mock inside an added test', "test('added', () => { vi.mock('../src/clamp'); expect(1).toEqual(1); });\n")):
            with self.subTest(bypass=label):
                self.protect(None)
                self.write('tests/protected.test.ts', self.original + extra)
                self.commit('add ' + label)
                self.guard(code=1, reasons=reasons)
        with self.subTest(control='reviewed added test'):
            self.protect(None)
            self.write('tests/protected.test.ts', self.original + "test('added', () => { expect(1).toEqual(1); });\n")
            self.commit('added test')
            self.guard(reasons=reasons)

    def test_sveltekit_generated_tsconfig_is_not_a_resolver_input_but_other_missing_extends_still_fail_closed(self):
        test = "import { clamp } from '../src/clamp';\n" + self.original
        for extended, code in (('./.svelte-kit/tsconfig.json', 0), ('./tsconfig.missing.json', 1)):
            with self.subTest(extends=extended):
                self.protect({'src/clamp.ts': 'export function clamp(x: number) { return x; }\n',
                              'tsconfig.json': json.dumps({'extends': extended})}, test)
                self.write('src/clamp.ts', 'export function clamp(x: number) { if (x < 0) return 0; return x; }\n')
                self.commit('fix')
                self.guard(code=code)

    def test_a_fix_in_the_module_under_test_passes(self):
        # Almost every real fix changes the module its named test imports; only test code is protected.
        test = "import { clamp } from '../src/clamp';\n" + self.original
        self.protect({'src/clamp.ts': 'export function clamp(x: number) { return x; }\n'}, test)
        self.write('src/clamp.ts', 'export function clamp(x: number) { if (x < 0) return 0; return x; }\n')
        self.commit('fix: clamp negatives')
        self.guard()
        self.assertEqual(self.last_receipt()['result'], 'PASS')
        # the same change to a helper under a test directory stays refused
        self.write('support/helper.ts', 'export function f(x: number) { return x; }\n')
        self.write('tests/protected.test.ts', "import { f } from '../support/helper';\n" + self.original)
        self.base = self.commit('helper baseline')
        self.write('support/helper.ts', 'export function f(x: number) { if (x < 0) return 0; return x; }\n')
        self.commit('helper control flow')
        self.guard(code=1)


class GuardAllowlist(GuardCase):
    """Diagnosing round, H2(c) as a class: a free test, a new import or a changed module may only add what cannot change
    what a named test proves. A recorded reason excuses free tests and new imports, never a mock, matcher, global or
    module patch, and never anything that runs before the named tests."""
    named_api = '''import { test, expect, vi } from 'vitest';
import * as api from '../src/api';
test('rejects stale evidence', () => {
  expect(api.validate('old')).toEqual(false);
  expect(api.validate('new')).toEqual(true);
});
'''
    api = "export const settings = { strict: true };\nexport function configure(strict: boolean) { settings.strict = strict; }\nexport function validate(v: string) { return v === 'new'; }\n"
    weakened = "export const settings = { strict: false };\nexport function configure(strict: boolean) { settings.strict = strict; }\nexport function validate(v: string) { return settings.strict ? v === 'new' : true; }\n"
    reason = {'tests/protected.test.ts': 'Reviewed addition of an independent test'}
    patch = "import { expect } from 'vitest';\nexpect.extend({ toEqual: () => ({ pass: true, message: () => '' }) });\nexport const patched = true;\n"

    def weaken(self, test, files=None, reasons=None, code=1):
        """The reviewed named test against reviewed code, then weakened code plus the test file `test`."""
        self.protect({'src/api.ts': self.api, **(files or {})}, self.named_api)
        self.write('src/api.ts', self.weakened)
        self.write('tests/protected.test.ts', test)
        self.commit('weaken')
        return self.guard(code=code, reasons=reasons)

    def place(self, free, where):
        """`free` as a new top-level test before or after the named test."""
        named = self.named_api.index("test('rejects")
        return self.named_api[:named] + free + self.named_api[named:] if where == 'before' else self.named_api + free

    def test_a_free_test_with_a_reason_cannot_spy_extend_or_patch_globals(self):
        free = {
            'vi.spyOn': "test('added', () => { vi.spyOn(api, 'validate').mockImplementation((v) => v !== 'old'); expect(1).toEqual(1); });\n",
            'expect.extend': "test('added', () => { expect.extend({ toEqual: () => ({ pass: true, message: () => '' }) }); expect(1).toEqual(1); });\n",
            'globalThis': "test('added', () => { Object.assign(globalThis, { validate: () => false }); expect(1).toEqual(1); });\n",
        }
        for label, body in free.items():
            for where in ('before', 'after'):
                with self.subTest(bypass=label, where=where):
                    self.assertIn('test-guard: FAIL', self.weaken(self.place(body, where), reasons=self.reason))

    def test_a_new_side_effect_or_unreviewed_import_refuses(self):
        head = "import '../lib/patch';\n"
        for label, (line, reasons) in {
            'side-effect import, no reason': (head, None),
            'side-effect import, with a reason': (head, self.reason),
            'named import of a new patch module, with a reason': ("import { patched } from '../lib/patch';\n", self.reason),
        }.items():
            with self.subTest(bypass=label):
                self.protect({'src/api.ts': self.api}, self.named_api)
                self.write('src/api.ts', self.weakened)
                self.write('lib/patch.ts', self.patch)
                self.write('tests/protected.test.ts', line + self.named_api)
                self.commit('import a matcher patch')
                self.guard(code=1, reasons=reasons)
        with self.subTest(bypass='named import of an unchanged module, no reason'):
            self.protect({'src/api.ts': self.api, 'src/other.ts': 'export const other = 1;\n'}, self.named_api)
            self.write('tests/protected.test.ts', "import { other } from '../src/other';\n" + self.named_api)
            self.commit('new import without a reason')
            self.guard(code=1)
        with self.subTest(bypass='named import of an unchanged module that patches expect, with a reason'):
            self.protect({'src/api.ts': self.api, 'src/matchers.ts': self.patch}, self.named_api)
            self.write('src/api.ts', self.weakened)
            self.write('tests/protected.test.ts', "import { patched } from '../src/matchers';\n" + self.named_api)
            self.commit('import an existing matcher patch')
            self.guard(code=1, reasons=self.reason)

    def test_a_changed_module_cannot_reach_the_test_framework(self):
        for label, text in {
            'imports vitest': self.patch + self.weakened,
            'global expect': "expect.extend({ toEqual: () => ({ pass: true, message: () => '' }) });\n" + self.weakened,
            'global vi': "vi.spyOn(console, 'error');\n" + self.weakened,
            'dynamic vitest import': "await import('vitest').then((v) => v.expect.extend({}));\n" + self.weakened,
            'matcher state symbol': "(Symbol.for('$$jest-matchers-object') as any);\n" + self.weakened,
        }.items():
            with self.subTest(bypass=label):
                self.protect({'src/api.ts': self.api}, self.named_api)
                self.write('src/api.ts', text)
                self.commit('patch the framework from the module under test')
                self.guard(code=1)
        with self.subTest(control='a local function named expect'):
            self.protect({'src/api.ts': self.api}, self.named_api)
            self.write('src/api.ts', self.api + "function expect(v: unknown) { return v; }\nexport const checked = expect(1);\n")
            self.commit('legitimate')
            self.guard()

    def test_runner_configuration_imports_are_resolved_and_protected(self):
        test = "import { test, expect } from 'vitest';\n" + self.original
        for specifier, file in (('./vitest.shared', 'vitest.shared.ts'), ('./vitest.shared.ts', 'vitest.shared.ts'),
                                ('./vitest.shared.js', 'vitest.shared.ts'), ('./vitest.shared.mjs', 'vitest.shared.mjs'),
                                ('./config/shared', 'config/shared.ts')):
            with self.subTest(bypass=f'config imports {specifier}'):
                shared = "export const shared = { include: ['tests/**/*.test.ts'], exclude: [] };\n"
                config = f"import {{ shared }} from '{specifier}';\nexport default {{ test: {{ ...shared }} }};\n"
                self.protect({'vitest.config.ts': config, file: shared}, test)
                self.write(file, shared.replace('exclude: []', "exclude: ['tests/protected.test.ts']"))
                self.commit('exclude the named test from an imported config module')
                self.assertIn('protected', self.guard(code=1))
        with self.subTest(bypass='transitive config import'):
            config = "import { shared } from './vitest.shared';\nexport default { test: { ...shared } };\n"
            shared = "import { skip } from './vitest.skip';\nexport const shared = { exclude: skip };\n"
            self.protect({'vitest.config.ts': config, 'vitest.shared.ts': shared, 'vitest.skip.ts': 'export const skip: string[] = [];\n'}, test)
            self.write('vitest.skip.ts', "export const skip = ['tests/protected.test.ts'];\n")
            self.commit('exclude through a transitive config import')
            self.guard(code=1)
        with self.subTest(bypass='unresolved local config import'):
            config = "import { shared } from './vitest.missing';\nexport default { test: { ...shared } };\n"
            self.protect({'vitest.config.ts': config}, test)
            self.write('app.txt', 'fixed\n')
            self.commit('fix')
            self.guard(code=1)
        with self.subTest(control='unchanged config closure and a fix in the module under test'):
            config = "import { shared } from './vitest.shared';\nimport { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { ...shared } });\n"
            self.protect({'vitest.config.ts': config, 'vitest.shared.ts': "export const shared = { exclude: [] };\n",
                          'src/clamp.ts': 'export function clamp(x: number) { return x; }\n'}, test)
            self.write('src/clamp.ts', 'export function clamp(x: number) { if (x < 0) return 0; return x; }\n')
            self.commit('fix')
            self.guard()

    def test_nothing_new_may_run_before_the_named_tests(self):
        # own variant: content the allowlist admits (a plain call into the module under test) still changes what the
        # named test proves when it runs first, in a free test placed before it or in a free describe body
        with self.subTest(bypass='free test before the named test restores module state'):
            self.weaken(self.place("test('added', () => { api.configure(true); expect(api.settings.strict).toBe(true); });\n", 'before'),
                        reasons=self.reason)
        with self.subTest(bypass='collection-time call in a free describe'):
            self.weaken(self.place("describe('added', () => { api.configure(true); test('x', () => { expect(1).toEqual(1); }); });\n", 'after'),
                        reasons=self.reason)
        with self.subTest(bypass='an earlier free test dropped'):
            earlier = "test('earlier', () => { expect(api.validate('x')).toBe(false); });\n"
            self.protect({'src/api.ts': self.api}, self.place(earlier, 'before'))
            self.write('tests/protected.test.ts', self.named_api)
            self.commit('drop an earlier free test')
            self.guard(code=1, reasons=self.reason)

    def test_free_test_content_outside_the_allowlist_refuses(self):
        # own variants: effects the install-call denylist never named, each placed after the named test
        for label, body in {
            'dynamic import of a patch module': "test('added', async () => { await import('../lib/patch'); expect(1).toEqual(1); });\n",
            'process.env assignment': "test('added', () => { process.env.STRICT = '0'; expect(1).toEqual(1); });\n",
            'assignment to an import binding member': "test('added', () => { api.settings.strict = false; expect(1).toEqual(1); });\n",
            'Object.defineProperty on a prototype': "test('added', () => { Object.defineProperty(Array.prototype, 'x', { value: 1 }); expect(1).toEqual(1); });\n",
            'expect passed out': "test('added', () => { api.configure(expect as any); expect(1).toEqual(1); });\n",
            'chai plugin through an assertion': "test('added', () => { (expect(1) as any).constructor.overwriteMethod('toEqual', () => () => {}); });\n",
            'a hook inside a free describe': "describe('added', () => { beforeAll(() => {}); test('x', () => { expect(1).toEqual(1); }); });\n",
            'test.concurrent': "test.concurrent('added', () => { expect(1).toEqual(1); });\n",
            'computed test name': "test(String(api.configure(true)), () => { expect(1).toEqual(1); });\n",
        }.items():
            with self.subTest(bypass=label):
                self.weaken(self.place(body, 'after'), {'lib/patch.ts': self.patch}, reasons=self.reason)

    def test_a_legitimate_free_test_and_import_pass(self):
        free = ("test('added', async () => {\n  const result = api.validate('x');\n  expect(result).toBe(false);\n"
                "  expect(Object.keys({ a: 1 })).toEqual(['a']);\n  expect(() => api.validate(null as any)).not.toThrow(TypeError);\n"
                "  for (const v of ['a', 'b']) expect(api.validate(v)).toBe(false);\n  await expect(Promise.resolve(other)).resolves.toBe(1);\n"
                "  expect({ v: api.validate('new') }).toEqual(expect.objectContaining({ v: true }));\n});\n"
                "describe('more', () => { it('nested', () => { expect(api.validate('new')).toBe(true); }); });\n")
        imports = "import { other } from '../src/other';\nimport { validate } from '../src/api';\n"
        self.protect({'src/api.ts': self.api, 'src/other.ts': 'export const other = 1;\n'}, self.named_api)
        self.write('src/api.ts', self.api.replace("v === 'new'", "v === 'new' && v.length === 3"))
        self.write('tests/protected.test.ts', imports + self.named_api + free)
        self.commit('fix with an added test')
        self.guard(reasons=self.reason)
        self.assertEqual(self.last_receipt()['result'], 'PASS')


    def test_framework_names_and_custom_registrations_refuse_whatever_they_are_bound_to(self):
        # vitest hoists vi.mock by name, so a vi re-exported by a reviewed helper is still vi; a file-level function
        # named like a registration can run its callback while tests are collected, before the named test
        helper = "export { vi } from 'vitest';\n"
        with self.subTest(bypass='vi re-exported by a support helper'):
            test = self.named_api.replace("import { test, expect, vi } from 'vitest';", "import { test, expect } from 'vitest';\nimport { vi } from '../support/helpers';")
            self.protect({'src/api.ts': self.api, 'support/helpers.ts': helper}, test)
            self.write('tests/protected.test.ts', test + "test('added', () => { vi.mock('../src/api'); expect(1).toEqual(1); });\n")
            self.commit('mock through a re-exported vi')
            self.guard(code=1, reasons=self.reason)
        with self.subTest(bypass='a file-level registration function'):
            test = self.named_api + "function it(name: string, fn: () => void) { fn(); }\n"
            self.protect({'src/api.ts': self.api}, test)
            self.write('src/api.ts', self.weakened)
            self.write('tests/protected.test.ts', test + "it('added', () => { api.configure(true); expect(1).toBe(1); });\n")
            self.commit('run a callback at collection')
            self.guard(code=1, reasons=self.reason)

    def test_setup_files_named_by_a_path_expression_or_without_an_extension_are_protected(self):
        test = "import { test, expect } from 'vitest';\n" + self.original
        for label, setup in (('dirname join', "join(__dirname, 'tests', 'setup.ts')"), ('import.meta.dirname resolve', "resolve(import.meta.dirname, 'tests/setup.ts')"),
                             ('URL', "fileURLToPath(new URL('./tests/setup.ts', import.meta.url))"), ('extensionless', "'./tests/setup'")):
            with self.subTest(bypass=label):
                config = ("import { join, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n"
                          f"export default {{ test: {{ setupFiles: [{setup}] }} }};\n")
                self.protect({'vitest.config.ts': config, 'tests/setup.ts': 'export {};\n'}, test)
                self.write('tests/setup.ts', "import { expect } from 'vitest';\nexpect.extend({ toEqual: () => ({ pass: true, message: () => '' }) });\n")
                self.commit('patch matchers in the setup file')
                self.assertIn('protected', self.guard(code=1))


class GuardReach(GuardCase):
    """GRS-148, the GRS-104 re-check's residual findings: code that runs in the named test's process but sat outside
    both the protected closure and the framework-reach check."""
    named_api, api, weakened = GuardAllowlist.named_api, GuardAllowlist.api, GuardAllowlist.weakened
    patch, reason = GuardAllowlist.patch, GuardAllowlist.reason
    weaken = GuardAllowlist.weaken
    # the matcher state's registry, reached without importing vitest
    symbol_patch = "(globalThis as any)[Symbol.for('$$jest-matchers-object')].customEqualityTesters.push(() => true);\nexport {};\n"

    def test_a_support_file_loaded_from_application_code_cannot_reach_the_framework(self):
        # finding 1 (high): a support-named file reached only from the module under test was skipped by the reach check
        for folder in ('support', 'fixtures', 'test-utils'):
            for label, patch in (('vitest import', self.patch), ('matcher symbol, no vitest import', self.symbol_patch)):
                with self.subTest(bypass=f'src/{folder}/patch.ts, {label}'):
                    self.protect({'src/api.ts': self.api}, self.named_api)
                    self.write('src/api.ts', f"import './{folder}/patch';\n" + self.weakened)
                    self.write(f'src/{folder}/patch.ts', patch)
                    self.commit('load a framework patch from the module under test')
                    self.assertIn('reaches the test framework', self.guard(code=1))
        with self.subTest(bypass='a changed support file that unchanged application code already loads'):
            api = "import { data } from './fixtures/data';\n" + self.api
            self.protect({'src/api.ts': api, 'src/fixtures/data.ts': 'export const data = 1;\n'}, self.named_api)
            self.write('src/api.ts', "import { data } from './fixtures/data';\n" + self.weakened)
            self.write('src/fixtures/data.ts', self.patch + 'export const data = 1;\n')
            self.commit('patch the framework from a loaded fixture')
            self.assertIn('reaches the test framework', self.guard(code=1))
        for label, files, line in (
                ('an unchanged support helper', {'tests/support/matchers.ts': self.patch}, "import '../tests/support/matchers';\n"),
                ('an unchanged support index re-exporting a patch', {'tests/support/matchers.ts': self.patch,
                 'tests/support/index.ts': "export * from './matchers';\n"}, "import { patched } from '../tests/support/index';\n"),
                ('an unchanged test file', {'tests/patch.test.ts': self.patch + "test('x', () => { expect(1).toBe(1); });\n"},
                 "import '../tests/patch.test';\n")):
            with self.subTest(bypass=f'application code newly loads {label}'):
                self.protect({'src/api.ts': self.api, **files}, self.named_api)
                self.write('src/api.ts', line + self.weakened)
                self.commit('load reviewed test code from the module under test')
                self.assertIn('newly loads', self.guard(code=1))
        with self.subTest(control='a new test file with its plain helper, and a script loading a plain test helper'):
            self.protect({'src/api.ts': self.api, 'tests/e2e/lib/env.ts': 'export const PORT = 1;\n'}, self.named_api)
            self.write('src/api.ts', self.api.replace("v === 'new'", "v === 'new' && v.length === 3"))
            self.write('tests/other.test.ts', "import { test, expect } from 'vitest';\nimport { one } from './support/plain';\n"
                       "test('other', () => { expect(one()).toBe(1); });\n")
            self.write('tests/support/plain.ts', 'export const one = () => 1;\n')
            self.write('scripts/measure.ts', "import { PORT } from '../tests/e2e/lib/env';\nexport const port = PORT;\n")
            self.commit('fix with a regression test in another file')
            self.guard()

    def test_a_new_import_cannot_run_import_time_code_before_the_named_test(self):
        # finding 2 (medium): imports evaluate before the named test, so a new import of an unchanged module whose top
        # level sets state changes what the named test proves
        strict = "import { configure } from './api';\nconfigure(true);\nexport const strict = true;\n"
        for label, files, line in (
                ('a top-level call', {'src/strict.ts': strict}, "import { strict } from '../src/strict';\n"),
                ('a re-export of a module with one', {'src/strict.ts': strict, 'src/flags.ts': "export { strict } from './strict';\n"},
                 "import { strict } from '../src/flags';\n"),
                ('a class static block', {'src/boot.ts': "import { configure } from './api';\nexport class Boot { static { configure(true); } }\n"},
                 "import { Boot } from '../src/boot';\n"),
                ('a top-level assignment', {'src/flip.ts': "import { settings } from './api';\nsettings.strict = true;\nexport const flipped = true;\n"},
                 "import { flipped } from '../src/flip';\n"),
                ('a package the reviewed test does not load', {'src/pkg.ts': "export { pad } from 'left-pad';\n"},
                 "import { pad } from '../src/pkg';\n")):
            with self.subTest(bypass=f'new import of {label}'):
                self.assertIn('import time', self.weaken(line + self.named_api, files, reasons=self.reason))
        with self.subTest(control='a new import of modules with no top-level effects'):
            consts = ("import type { Kind } from './types';\nimport { join } from 'node:path';\nimport { base } from './base';\n"
                      "import { configure } from './api';\nexport const LIMIT = base + 1;\nexport const kinds: Kind[] = ['a'];\n"
                      "export function setup() { configure(true); return join('a', 'b'); }\n"
                      "export class Box { static size = LIMIT * 2; open() { configure(false); } }\nexport default { LIMIT };\n")
            self.protect({'src/api.ts': self.api, 'src/consts.ts': consts, 'src/base.ts': 'export const base = 1;\n',
                          'src/types.ts': "export type Kind = 'a';\n"}, self.named_api)
            self.write('src/api.ts', self.api.replace("v === 'new'", "v === 'new' && v.length === 3"))
            self.write('tests/protected.test.ts', "import { LIMIT } from '../src/consts';\n" + self.named_api
                       + "test('limit', () => { expect(LIMIT).toBe(2); });\n")
            self.commit('fix with a test of a constant')
            self.guard(reasons=self.reason)
        with self.subTest(control='a new import of a helper the reviewed test already loads'):
            helpers = {'support/a.ts': "export * from './b';\n",
                       'support/b.ts': "import { configure } from '../src/api';\nconfigure(true);\nexport const ready = true;\n"}
            test = "import { ready } from '../support/a';\n" + self.named_api
            self.protect({'src/api.ts': self.api, **helpers}, test)
            self.write('tests/protected.test.ts', "import { ready as loaded } from '../support/b';\n" + test
                       + "test('ready', () => { expect(loaded).toBe(true); });\n")
            self.commit('import a loaded helper directly')
            self.guard(reasons=self.reason)

    def test_every_setup_file_entry_binds_to_a_file_or_the_guard_fails_closed(self):
        # finding 3 (medium, latent): setup files named by a template literal or a process.cwd() join were not resolved,
        # and an entry the resolver could not bind did not fail closed; bun's preload list is the same shape
        test = "import { test, expect } from 'vitest';\n" + self.original
        # a setup file that never touches the framework but stubs the global the named test calls
        stub = "(globalThis as any).validate = (v: string) => v === 'new';\nexport {};\n"
        head = "import { join } from 'node:path';\n"
        for label, files in (
                ('dirname template literal', {'vitest.config.ts': "export default { test: { setupFiles: [`${__dirname}/tests/setup.ts`] } };\n"}),
                ('process.cwd join', {'vitest.config.ts': head + "export default { test: { setupFiles: [join(process.cwd(), 'tests', 'setup.ts')] } };\n"}),
                ('bunfig preload', {'bunfig.toml': '[test]\npreload = ["./tests/setup.ts"]\n'})):
            with self.subTest(bypass=label):
                self.protect({**files, 'tests/setup.ts': 'export {};\n'}, test)
                self.write('tests/setup.ts', stub)
                self.commit('stub a global in the setup file')
                self.assertIn('protected dependency', self.guard(code=1))
        for label, files in (
                ('a variable', {'vitest.config.ts': head + "const setup = join(process.env.ROOT ?? '.', 'tests/setup.ts');\nexport default { test: { setupFiles: [setup] } };\n"}),
                ('a call', {'vitest.config.ts': "const pick = () => ['tests/setup.ts'];\nexport default { test: { globalSetup: pick() } };\n"}),
                ('a spread', {'vitest.config.ts': "const shared = ['tests/setup.ts'];\nexport default { test: { setupFiles: [...shared] } };\n"}),
                ('a shorthand property', {'vitest.config.ts': "const setupFiles = ['tests/setup.ts'];\nexport default { test: { setupFiles } };\n"}),
                ('a missing file', {'vitest.config.ts': "export default { test: { setupFiles: ['./tests/missing.ts'] } };\n"}),
                ('a bunfig preload that is not a string list', {'bunfig.toml': '[test]\npreload = { file = "./tests/setup.ts" }\n'}),
                ('a bunfig preload in an inline table', {'bunfig.toml': 'test = { preload = "./tests/setup.ts" }\n'})):
            with self.subTest(bypass=f'an unbound entry: {label}'):
                self.protect({**files, 'tests/setup.ts': 'export {};\n'}, test)
                self.write('tests/setup.ts', stub)
                self.commit('stub a global in the setup file')
                self.assertIn('cannot bind', self.guard(code=1))
        with self.subTest(control='an unchanged config with path-built setup files and a fix in the module under test'):
            config = head + ("export default { test: { setupFiles: [`${__dirname}/tests/setup.ts`, join(process.cwd(), 'tests/more.ts')],"
                             " globalSetup: './tests/global.ts' } };\n")
            self.protect({'vitest.config.ts': config, 'tests/setup.ts': 'export {};\n', 'tests/more.ts': 'export {};\n',
                          'tests/global.ts': 'export default () => {};\n', 'tests/preload.ts': 'export {};\n',
                          'bunfig.toml': '[test]\npreload = ["./tests/setup.ts", "./tests/preload.ts"] # two files\n',
                          'src/clamp.ts': 'export function clamp(x: number) { return x; }\n'}, test)
            self.write('src/clamp.ts', 'export function clamp(x: number) { if (x < 0) return 0; return x; }\n')
            self.commit('fix')
            self.guard()

    def test_a_changed_module_cannot_reach_the_runner_through_computed_names(self):
        # finding 4 (medium): a computed Symbol.for name and a computed key on globalThis reached the matcher state;
        # decision: refuse the global object's computed members, framework-named members, aliases and hand-offs
        for label, text in {
            'computed Symbol.for and globalThis key': "const key = Symbol.for(['$$jest', 'matchers', 'object'].join('-'));\n(globalThis as any)[key].customEqualityTesters.push(() => true);\n",
            'a computed global name': "const name = ['__vitest', 'worker__'].join('_');\n(globalThis as any)[name].config.sequence = {};\n",
            'an alias of the global object': "const g: any = globalThis;\nconst k = 'cus' + 'tomEqualityTesters';\ng[Object.getOwnPropertySymbols(g)[0]][k].push(() => true);\n",
            'the global object passed on': "const k = Reflect.ownKeys(globalThis).find((s) => String(s).includes('matchers'));\n",
            'a framework global by its literal name': "(globalThis as any).__vitest_worker__.config.sequence = {};\n",
            'globals-mode expect on the global object': "(window as any)['expect'].extend({ toEqual: () => ({ pass: true, message: () => '' }) });\n",
            'computed destructuring of the global object': "const { [String(1)]: state } = globalThis as any;\n",
        }.items():
            with self.subTest(bypass=label):
                self.protect({'src/api.ts': self.api}, self.named_api)
                self.write('src/api.ts', text + self.weakened)
                self.commit('reach the runner through a computed name')
                self.assertIn('reaches the test framework', self.guard(code=1))
        with self.subTest(control='literal globals and a non-framework symbol, as application code uses them'):
            app = ("const g = globalThis as { __clearcase?: { n: number } };\ng.__clearcase ??= { n: 1 };\n"
                   "const cache = (globalThis as any)[Symbol.for('app.cache')] ?? new Map();\n"
                   "export const ready = Boolean(globalThis.performance) && g.__clearcase.n === 1 && cache instanceof Map;\n")
            self.protect({'src/api.ts': self.api}, self.named_api)
            self.write('src/api.ts', app + self.api)
            self.commit('legitimate')
            self.guard()

    def test_the_same_shapes_elsewhere_refuse(self):
        # class sweep: the framework loaded through a renamed require, a support component a change newly loads, and a
        # bare setup entry that names neither a tracked file nor a declared package
        for label, text in {
            'createRequire': "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\n"
                             "load('vitest').expect.extend({ toEqual: () => ({ pass: true, message: () => '' }) });\n",
            'a scoped framework package by name': "const load = (globalThis as any).require ?? (() => ({}));\nexport const m = [load][0]('@vitest/expect');\n",
        }.items():
            with self.subTest(bypass=label):
                self.protect({'src/api.ts': self.api}, self.named_api)
                self.write('src/api.ts', text + self.weakened)
                self.commit('load the framework under another name')
                self.assertIn('reaches the test framework', self.guard(code=1))
        with self.subTest(bypass='application code newly loads an unchanged support component'):
            component = "<script lang=\"ts\">\n" + self.patch + "</script>\n<p>x</p>\n"
            self.protect({'src/api.ts': self.api, 'tests/support/Patch.svelte': component}, self.named_api)
            self.write('src/api.ts', "import '../tests/support/Patch.svelte';\n" + self.weakened)
            self.commit('load a support component from the module under test')
            self.assertIn('newly loads', self.guard(code=1))
        test = "import { test, expect } from 'vitest';\n" + self.original
        package = json.dumps({'name': 'x', 'devDependencies': {'@testing-library/jest-dom': '6.0.0'}})
        with self.subTest(bypass='a bare setup entry naming an ignored file'):
            self.protect({'.gitignore': 'setup.ts\n', 'package.json': package,
                          'vitest.config.ts': "export default { test: { setupFiles: ['setup.ts'] } };\n"}, test)
            self.write('setup.ts', "(globalThis as any).validate = () => false;\n")
            self.write('app.txt', 'fixed\n')
            self.commit('fix')
            self.assertIn('cannot bind', self.guard(code=1))
        with self.subTest(control='a setup entry naming a declared package'):
            self.protect({'package.json': package,
                          'vitest.config.ts': "export default { test: { setupFiles: ['@testing-library/jest-dom/vitest'] } };\n"}, test)
            self.write('app.txt', 'fixed\n')
            self.commit('fix')
            self.guard()

    def test_a_changed_test_file_is_exempt_only_while_test_files_are_isolated(self):
        # class sweep: test files are left out of the reach check because the runner isolates each; a configuration
        # that shares one process between them, or bun's runner, which does, voids that
        other = "import { test, expect } from 'vitest';\n" + self.patch + "test('other', () => { expect(1).toBe(1); });\n"
        for n, (label, files, test) in enumerate((
                ('isolate: false', {'vitest.config.ts': "export default { test: { isolate: false } };\n"}, self.named_api),
                ('a single fork', {'vitest.config.ts': "export default { test: { poolOptions: { forks: { singleFork: true } } } };\n"}, self.named_api),
                ('--no-isolate in the test script', {'package.json': json.dumps({'name': 'x', 'scripts': {'test': 'vitest run --no-isolate'}})}, self.named_api),
                ('bun:test', {}, self.named_api.replace("from 'vitest'", "from 'bun:test'")))):
            with self.subTest(bypass=label):
                self.protect({'src/api.ts': self.api, **files}, test)
                self.write('src/api.ts', self.weakened)
                # a new file each time: one left by an earlier subtest is unchanged in this diff
                self.write(f'tests/other-{n}.test.ts', other.replace("from 'vitest'", "from 'bun:test'") if label == 'bun:test' else other)
                self.commit('patch the framework from another test file')
                self.assertIn('isolat', self.guard(code=1))
        with self.subTest(bypass='a test script that runs bun test'):
            self.protect({'src/api.ts': self.api, 'package.json': json.dumps({'name': 'x', 'scripts': {'test': 'bun test --timeout 5000'}})}, self.named_api)
            self.write('src/api.ts', self.weakened)
            self.write('tests/other-bun.test.ts', other)
            self.commit('patch the framework from another test file')
            self.assertIn('isolat', self.guard(code=1))
        with self.subTest(control='isolation named only in comments, and bun running vitest'):
            config = "// `bun run --bun test` runs this; isolate: false is not set, nor singleFork: true\nexport default { test: { pool: 'forks' } };\n"
            self.protect({'src/api.ts': self.api, 'vitest.config.ts': config,
                          'package.json': json.dumps({'name': 'x', 'scripts': {'test': 'vitest run', 'test:all': 'bun run --bun test'}})}, self.named_api)
            self.write('src/api.ts', self.api.replace("v === 'new'", "v === 'new' && v.length === 3"))
            self.write('tests/other-control.test.ts', "import { test, expect } from 'vitest';\ntest('other', () => { expect(1).toBe(1); });\n")
            self.commit('fix with a regression test in another file')
            self.guard()

    def test_the_guard_itself_may_change_alongside_a_fix(self):
        # the guard's own source is a module outside the closure when a later ticket changes it: it must not read as
        # reaching the framework
        guard = (TOOLS / 'test_guard.mjs').read_text()
        packages = json.dumps({'name': 'x', 'devDependencies': {'typescript': '6.0.3', 'svelte': '5.57.2'}})  # as the repository declares them
        self.protect({'src/api.ts': self.api, 'scripts/agent-tools/test_guard.mjs': guard, 'package.json': packages}, self.named_api)
        self.write('scripts/agent-tools/test_guard.mjs', guard + '// a later change\n')
        self.commit('change the guard')
        self.guard()


class GuardRoutes(GuardCase):
    """GRS-148 fix round: each route by which a changed file makes a named test pass on weakened code, closed as a
    class: the loader's unbound specifiers and the test-file exemption (H1), builtin mutation (H2), global-object
    aliases (M1), Svelte script extraction (M2) and the per-named-file closure (M3)."""
    named_api, api, weakened = GuardAllowlist.named_api, GuardAllowlist.api, GuardAllowlist.weakened
    patch, reason = GuardAllowlist.patch, GuardAllowlist.reason
    extend = "expect.extend({ toEqual: () => ({ pass: true, message: () => '' }) });\n"
    patch_test = "import { test, expect } from 'vitest';\n" + extend + "test('other', () => { expect(1).toBe(1); });\n"
    # the matcher registry through the global object held under a name `g`
    registry = ("const s = Object.getOwnPropertySymbols(%s).find((x) => String(x).includes('jest-matchers')) as symbol;\n"
                "%s[s].customEqualityTesters.push(() => true);\n")
    counter = 0

    def fresh(self, name):
        """A file name no earlier subtest wrote: subtests share one repository."""
        GuardRoutes.counter += 1
        stem, dot, extension = name.partition('.')
        return f'{stem}-{GuardRoutes.counter}{dot}{extension}'

    def route(self, label, head, base=None, why=None, test=None, reasons=None, delete=()):
        """The reviewed state (the module under test, `base`), then `head` written over it. `why` is what a refusal says;
        None is a positive control that must pass."""
        with self.subTest(route=label):
            self.protect({'src/api.ts': self.api, **(base or {})}, test or self.named_api)
            for name, text in head.items():
                self.write(name, text)
            for name in delete:
                (self.repo / name).unlink()
            self.commit(label)
            if why is None:
                self.guard(reasons=reasons)
            else:
                self.assertIn(why, self.guard(code=1, reasons=reasons))

    def test_every_specifier_a_changed_module_loads_binds_or_the_guard_fails_closed(self):
        # H1, the loader: loads() dropped a specifier the resolver could not bind, so a root-relative or ?query edge to a
        # new test file went unseen
        for label, spec in (('a root-relative path', '/tests/%s'), ('a query suffix', '../tests/%s?x'),
                            ('a fragment', '../tests/%s#frag'), ('an extensionless root-relative path', '/tests/%s')):
            name = self.fresh('patch.test.ts')
            target = name[:-3] if 'extensionless' in label else name
            self.route(f'application code imports a new test file by {label}',
                       {'src/api.ts': f"import '{spec % target}';\n" + self.weakened, f'tests/{name}': self.patch_test},
                       why='newly loads the test file')
        for label, line in (('a missing local module', "import './generated';\n"), ('an undeclared package', "import 'left-pad';\n"),
                            ('a literal dynamic import', "void import('./missing');\n"), ('a require', "const m = require('./missing');\n"),
                            ('a re-export', "export * from './missing';\n"), ('a root-relative missing module', "import '/nowhere/x';\n")):
            self.route(f'an unbound specifier: {label}', {'src/api.ts': line + self.weakened}, why='binds to no')
        manifest = json.dumps({'name': 'x', 'devDependencies': {'left-pad': '1.0.0', '@scope/pkg': '1.0.0'}})
        self.route('every kind of specifier that does bind',
                   {'src/api.ts': ("import { pad } from 'left-pad';\nimport scoped from '@scope/pkg/sub';\nimport { join } from 'node:path';\n"
                                   "import { readFileSync } from 'fs';\nimport { building } from '$app/environment';\n"
                                   "import { PUBLIC_X } from '$env/static/public';\nimport { version } from '$service-worker';\n"
                                   "import type { PageLoad } from './$types';\nimport logo from './logo.png?url';\n"
                                   "import { lib } from '$lib/lib';\nimport { rooted } from '/src/rooted';\n"
                                   "import { run } from './run.js';\n") + self.weakened,
                    'src/logo.png': 'png\n', 'src/lib/lib.ts': 'export const lib = 1;\n', 'src/rooted.ts': 'export const rooted = 1;\n',
                    'src/run.ts': 'export const run = 1;\n'}, base={'package.json': manifest})

    def test_a_test_file_a_module_loads_loses_its_exemption(self):
        # H1, the exemption: a changed test file is left to its assertion count only while nothing but the runner loads it
        limits = "import { test, expect } from 'vitest';\nexport const LIMIT = 3;\ntest('limit', () => { expect(LIMIT).toBe(3); });\n"
        patched = limits.replace('export const', self.extend + 'export const')
        name = self.fresh('limits.test.ts')
        imp = f"import {{ LIMIT }} from './{name[:-3]}';\nexport const limit = LIMIT;\n"
        self.route('application code already loads an existing test file, which is patched in place',
                   {'src/api.ts': imp + self.weakened, f'src/{name}': patched},
                   base={'src/api.ts': imp + self.api, f'src/{name}': limits}, why='is loaded by')
        name = self.fresh('limits.test.ts')
        self.route('a support helper already loads an existing test file, which is patched in place',
                   {'src/api.ts': self.weakened, f'src/{name}': patched},
                   base={'tests/support/helper.ts': f"export {{ LIMIT }} from '../../src/{name[:-3]}';\n", f'src/{name}': limits},
                   why='is loaded by')
        name = self.fresh('limits.test.ts')
        self.route('a changed test file only the runner loads',
                   {f'tests/{name}': limits, 'src/api.ts': self.api.replace("v === 'new'", "v === 'new' && v.length === 3")},
                   base={f'tests/{name}': limits.replace('3', '4')})

    def test_a_changed_module_cannot_mutate_a_builtin(self):
        # H2: Object.is = () => true made toEqual and toBe pass, with no framework name and no global object in sight
        for label, line in {
            'an assignment to a builtin member': 'Object.is = () => true;\n',
            'an assignment to a prototype': 'Array.prototype.includes = () => true;\n',
            'a delete': 'delete Object.is;\n',
            'a logical assignment': 'Object.is ||= () => true;\n',
            'an assignment through an alias': 'const O = Object;\nO.is = () => true;\n',
            'a destructuring assignment target': '[Object.is] = [() => true];\n',
            'a property destructuring target': '({ is: Object.is } = { is: () => true });\n',
            'a for-of target': 'for (Object.is of [() => true]);\n',
            'an assignment through the global object': '(globalThis as any).Object.is = () => true;\n',
            'defineProperty': "Object.defineProperty(Object, 'is', { value: () => true });\n",
            'defineProperties': "Object.defineProperties(Object, { is: { value: () => true } });\n",
            'Object.assign': 'Object.assign(Object, { is: () => true });\n',
            'setPrototypeOf': 'Object.setPrototypeOf(Array.prototype, { includes: () => true });\n',
            'Reflect.set': "Reflect.set(Object, 'is', () => true);\n",
            'Reflect.defineProperty': "Reflect.defineProperty(Object, 'is', { value: () => true });\n",
            'a mutator held in a variable': "const d = Object.defineProperty;\nd(Object, 'is', { value: () => true });\n",
            'a mutator called through call': "Object.defineProperty.call(null, Object, 'is', { value: () => true });\n",
            'a prototype reached by getPrototypeOf': 'Object.getPrototypeOf([]).includes = () => true;\n',
            'a prototype reached through constructor': '[].constructor.prototype.includes = () => true;\n',
            'a prototype reached through __proto__': '({} as any).__proto__.is = () => true;\n',
            'a prototype kept in a variable': 'const p = Object.getPrototypeOf([]);\np.includes = () => true;\n',
            'a member of an imported builtin module': "import fs from 'node:fs';\n(fs as any).readFileSync = () => '';\n",
            'a builtin handed to a function': "function d(o: object) { Object.defineProperty(o, 'is', { value: () => true }); }\nd(Object);\n",
            'a prototype from getPrototypeOf handed to a function': "function d(o: object) { Object.defineProperty(o, 'includes', { value: () => true }); }\nd(Object.getPrototypeOf([]));\n",
        }.items():
            self.route(f'a changed module mutates a builtin: {label}', {'src/api.ts': line + self.weakened}, why='reaches the test framework')
        self.route('plain mutation of the module\'s own objects and constructors',
                   {'src/api.ts': ("const o: Record<string, number> = { a: 1 };\no.a = 2;\ndelete o.a;\nObject.assign(o, { b: 1 });\n"
                                   "Object.defineProperty(o, 'c', { value: 1 });\nfunction Foo() {}\nFoo.prototype.bar = function () { return 1; };\n"
                                   "import { readFileSync } from 'node:fs';\nimport * as path from 'node:path';\nexport const here = path.join('a', String(readFileSync.length));\n"
                                   "let count = 0;\ncount++;\nexport const next = () => count++;\nconst copy = Object.assign({}, o);\n"
                                   "export const table = Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, v + 1]));\n") + self.weakened})

    def test_a_changed_module_may_hold_the_global_object_only_as_a_literal_property_read(self):
        # M1: an allowlist, not a list of the aliases the guard knew: any other holder of the global object refuses
        for label, line in {
            'an array element': "const g: any = [globalThis][0];\n" + self.registry % ('g', 'g'),
            'a destructuring rename': "const { globalThis: g } = globalThis as any;\n" + self.registry % ('g', 'g'),
            'a conditional': "const g: any = Math.random() < 2 ? globalThis : null;\n" + self.registry % ('g', 'g'),
            'a later assignment': "let g: any;\ng = globalThis;\n" + self.registry % ('g', 'g'),
            'a comma expression': "const s = Object.getOwnPropertySymbols((0, globalThis)).find((x) => String(x).includes('jest-matchers')) as symbol;\n"
                                  "((0, globalThis) as any)[s].customEqualityTesters.push(() => true);\n",
            'an object property': "const s = Object.getOwnPropertySymbols(({ g: globalThis }).g).find((x) => String(x).includes('jest-matchers')) as symbol;\n"
                                  "({ g: globalThis } as any).g[s].customEqualityTesters.push(() => true);\n",
            'a function parameter': "const reach = (g: any) => g[Object.getOwnPropertySymbols(g)[0]];\nreach(globalThis).customEqualityTesters.push(() => true);\n",
            'a returned value': "const here = () => globalThis as any;\nconst g = here();\n" + self.registry % ('g', 'g'),
            'an alias used by something other than a property read': "const g: any = globalThis;\nconst h = g;\n" + self.registry % ('h', 'h'),
            'window': "const g: any = window;\n" + self.registry % ('g', 'g'),
            'Symbol.for held in a variable': "const f = Symbol.for;\n(globalThis as any)[f('$$jest-matchers-object')].customEqualityTesters.push(() => true);\n",
            'Symbol.for through a computed member': "(globalThis as any)[(Symbol as any)['f' + 'or']('$$jest-matchers-object')].customEqualityTesters.push(() => true);\n",
            'Symbol itself aliased': "const S = Symbol;\n(globalThis as any)[S.for('$$jest-matchers-object')].customEqualityTesters.push(() => true);\n",
            'Symbol.for with a computed name': "(globalThis as any)[Symbol.for(['$$jest', 'matchers-object'].join('-'))].customEqualityTesters.push(() => true);\n",
        }.items():
            self.route(f'a changed module holds the global object as {label}', {'src/api.ts': line + self.weakened}, why='reaches the test framework')
        self.route('literal property reads, a const alias used only for them, and a direct literal Symbol.for',
                   {'src/api.ts': ("const g = globalThis as { __clearcase?: { n: number } };\ng.__clearcase ??= { n: 1 };\n"
                                   "const cache = (globalThis as any)[Symbol.for('app.cache')] ?? new Map();\n"
                                   "const browser = typeof window !== 'undefined' && 'document' in globalThis;\n"
                                   "const now = globalThis.performance?.now() ?? 0;\nconst { performance } = globalThis;\n"
                                   "export const ready = Boolean(globalThis.performance) && g.__clearcase.n === 1 && cache instanceof Map"
                                   " && browser === false && now >= 0 && performance !== undefined && typeof globalThis['fetch'] === 'function';\n")
                    + self.weakened})

    def test_a_svelte_component_is_read_by_the_compiler(self):
        # M2: the <script> regex ended a tag at the first '>', so a '>' inside an attribute hid the script, and the markup
        # (event handlers, {expressions}) was never read at all
        hidden = ("<script module lang=\"ts\" data-x=\"a>b\">import { expect } from 'vitest'; " + self.extend.strip() + "</script>\n<p>x</p>\n")
        registry = "(globalThis as any)[Object.getOwnPropertySymbols(globalThis as any)[0]].customEqualityTesters.push(() => true)"
        for label, component, why in (
                ('a > inside a script attribute', hidden, 'reaches the test framework'),
                ('a single-quoted < inside a script attribute', hidden.replace('data-x="a>b"', "data-x='<'"), 'reaches the test framework'),
                ('the markup of a component', f"<script lang=\"ts\">let a = 1;</script>\n<button onclick={{() => {registry}}}>{{a}}</button>\n", 'reaches the test framework'),
                ('a markup expression', f"<script lang=\"ts\">let a = 1;</script>\n{{{registry}}}\n", 'reaches the test framework'),
                ('a component that does not parse', "<script>let a = ;</script>\n<p>x</p>\n", 'cannot parse')):
            name = self.fresh('Patch.svelte')
            self.route(f'a Svelte component with {label}', {'src/api.ts': f"import './{name}';\n" + self.weakened, f'src/{name}': component}, why=why)
        name = self.fresh('Plain.svelte')
        self.route('a component with runes, markup and a style',
                   {'src/api.ts': f"import './{name}';\n" + self.weakened,
                    f'src/{name}': ("<script lang=\"ts\">\nlet { a }: { a: number } = $props();\nlet n = $state(0);\n</script>\n"
                                    "{#if a}<button onclick={() => n++}>{n}</button>{/if}\n<style>button { color: red; }</style>\n")})

    def test_the_modules_a_named_test_loads_are_those_of_that_test_file(self):
        # M3: the loaded set was the union over every named file, so file A could newly import the effectful helper only
        # file B loaded
        helper = "import { configure } from '../src/api';\nconfigure(true);\nexport const ready = true;\n"
        other = "import { test, expect } from 'vitest';\nimport { ready } from '../support/b';\ntest('b works', () => { expect(ready).toBe(true); });\n"
        self.named = [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}, {'file': 'tests/b.test.ts', 'name': 'b works'}]
        files = {'support/b.ts': helper, 'tests/b.test.ts': other}
        test = "import { ready } from '../support/b';\n" + self.named_api + "test('ready', () => { expect(ready).toBe(true); });\n"
        self.route('file A newly imports the effectful helper only file B loads', {'src/api.ts': self.weakened, 'tests/protected.test.ts': test},
                   base=files, why='must name a module the reviewed file imports', reasons=self.reason)
        reviewed = "import { ready } from '../support/b';\n" + self.named_api
        self.route('file A newly imports a helper it already loads',
                   {'tests/protected.test.ts': "import { ready as loaded } from '../support/b';\n" + reviewed
                    + "test('ready', () => { expect(loaded).toBe(true); });\n"},
                   base=files, test=reviewed, reasons=self.reason)


class GuardBinding(ControlCase):
    """H1: once a fix attempt is recorded, approval needs a PASS guard receipt bound to the reviewed commit and findings."""
    unit = 'GRS-104/implementation'
    original = TestWeakening.original
    tests = [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]
    manifest_path = 'docs/acceptance/fix-rounds/GRS-104-1.json'
    prepare = ApprovalLedger.prepare

    def setUp(self):
        super().setUp()
        self.write('tests/protected.test.ts', self.original)
        self.reviewed = self.commit('reviewed tests')
        self.start(self.unit, {'protectedTests': self.tests})

    def start(self, unit, extra):
        """A review of the reviewed commit with a high, then the unit's initial and fix dispatches."""
        self.review_findings = self.document(f'first-findings-{unit[4:7]}.json', {
            'sha': self.reviewed, 'updatedAt': '2026-10-17T09:00:00+00:00',
            'unresolvedFindings': [{'id': 'H1', 'severity': 'high'}], **extra})
        first = self.document(f'first-review-{unit[4:7]}.json', {
            'schema': 'clearcase-review/1', 'sha': self.reviewed, 'verdict': 'FAIL',
            'findingsSha256': hashlib.sha256(self.review_findings.read_bytes()).hexdigest(),
            'unresolvedFindings': [{'id': 'H1', 'severity': 'high'}]})
        self.cli('review-record', '--unit', unit, '--review', first, '--findings', self.review_findings)
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        self.cli('dispatch', '--unit', unit, '--phase', 'initial', '--task-id', 'impl', '--deadline', deadline)
        self.cli('dispatch', '--unit', unit, '--phase', 'fix', '--task-id', 'fix')

    def guarded(self, code=0, fix_base=None, unit=None, **overrides):
        data = {'schema': 'clearcase-fix-round/1', 'unit': unit or self.unit, 'fixBase': fix_base or self.reviewed,
                'reviewFindingsSha256': hashlib.sha256(self.review_findings.read_bytes()).hexdigest(),
                'tests': self.tests, **overrides}
        self.write(self.manifest_path, json.dumps(data))
        self.write('app.txt', 'fixed\n')
        self.commit('fix round')
        self.cli('test-guard', '--fix-base', data['fixBase'], '--findings', self.repo / self.manifest_path, code=code)
        self.guard_receipt = sorted(self.receipts.glob('*/receipt.json'))[-1]

    def approve(self, *extra, code=0):
        return self.cli('approve', '--unit', self.unit, '--sha', self.sha, '--review', self.review,
                        '--findings', self.findings, '--check-receipt', self.check, '--approved-by', 'coordinator',
                        *extra, code=code)

    def weaken(self):
        self.write('tests/protected.test.ts', self.original.replace('.toEqual(false)', '.toBeDefined()'))
        return self.commit('weaken the named test')

    def test_a_recorded_fix_attempt_needs_a_guard_receipt_to_approve(self):
        self.guarded()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('guard', self.approve(code=1))

    def test_a_bound_guard_receipt_approves_and_reads_back(self):
        self.guarded()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve('--guard-receipt', self.guard_receipt)
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertEqual(json.loads(approved.read_text())['approval']['guard']['fixBase'], self.reviewed)
        self.cli('approval-check', '--unit', self.unit, '--sha', self.sha, '--approval-receipt', approved)
        data = json.loads(self.guard_receipt.read_text())
        data['guard']['tests'] = []
        self.guard_receipt.write_text(json.dumps(data))
        self.cli('approval-check', '--unit', self.unit, '--sha', self.sha, '--approval-receipt', approved, code=1)

    def guarded_approval_reads_back(self):
        self.guarded()
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve('--guard-receipt', self.guard_receipt)
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertNotIn(self.env['HOME'] + '/', approved.read_text())
        self.cli('approval-check', '--unit', self.unit, '--sha', self.sha, '--approval-receipt', approved)

    def test_a_guard_receipt_under_home_approves_and_reads_back(self):
        """PR #62 re-check r2 (M2): the coordinator's store lives under HOME. The fresh binding names the guard
        receipt exactly and so must the stored one, never ~/... beside a raw path."""
        self.env['HOME'] = str(self.work)
        self.guarded_approval_reads_back()

    def test_protected_test_paths_holding_the_home_text_bind_and_read_back(self):
        """The guard's tests are compared from their exact record: HOME=/protected.test.ts displays the protected
        file tests/protected.test.ts as tests~."""
        self.env['HOME'] = '/protected.test.ts'
        self.guarded_approval_reads_back()

    def test_a_manifest_naming_a_later_fix_base_does_not_bind(self):
        weakened = self.weaken()
        self.guarded(fix_base=weakened)  # the guard passes: nothing changed since the weakening
        self.assertEqual(json.loads(self.guard_receipt.read_text())['result'], 'PASS')
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('fix base', self.approve('--guard-receipt', self.guard_receipt, code=1))

    def test_a_manifest_dropping_the_weakened_test_does_not_bind(self):
        # The manifest names a test that runs before the weakened one, so the guard alone passes (a weakened test
        # before the named one is refused by the guard itself); the binding must still refuse.
        earlier = "test('earlier behavior', () => { expect(1).toEqual(1); });\n"
        self.write('tests/protected.test.ts', earlier + self.original)
        self.reviewed = self.commit('reviewed tests with an earlier test')
        self.unit = 'GRS-105/implementation'
        self.start(self.unit, {'protectedTests': self.tests})
        self.write('tests/protected.test.ts', earlier + self.original.replace('.toEqual(false)', '.toBeDefined()'))
        self.commit('weaken the named test')
        self.guarded(tests=[{'file': 'tests/protected.test.ts', 'name': 'earlier behavior'}],
                     assertionCountReasons={'tests/protected.test.ts': 'Tidy'})
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('tests', self.approve('--guard-receipt', self.guard_receipt, code=1))

    def test_a_manifest_naming_a_test_after_the_weakened_one_is_refused_by_the_guard(self):
        self.weaken()
        self.guarded(tests=[{'file': 'tests/protected.test.ts', 'name': 'other behavior'}],
                     assertionCountReasons={'tests/protected.test.ts': 'Tidy'}, code=1)
        self.assertEqual(json.loads(self.guard_receipt.read_text())['result'], 'FAIL')

    def test_a_manifest_for_other_findings_does_not_bind(self):
        self.guarded(reviewFindingsSha256='0' * 64)
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('findings', self.approve('--guard-receipt', self.guard_receipt, code=1))

    def test_a_failing_guard_receipt_does_not_approve(self):
        self.weaken()
        self.guarded(code=1)
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve('--guard-receipt', self.guard_receipt, code=1)

    def test_a_review_that_names_no_protected_tests_cannot_prompt_a_guarded_fix(self):
        self.unit = 'GRS-105/implementation'
        self.start(self.unit, {})
        self.guarded(unit=self.unit)
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.assertIn('protectedTests', self.approve('--guard-receipt', self.guard_receipt, code=1))

    def test_a_review_that_names_nothing_to_protect_needs_no_guard_receipt(self):
        self.unit = 'GRS-105/implementation'
        self.start(self.unit, {'protectedTests': []})
        self.write('app.txt', 'fixed\n')
        self.commit('fix round')
        self.prepare([{'id': 'L1', 'severity': 'low'}])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertTrue(json.loads(approved.read_text())['approval']['guard']['nothingToProtect'])


class FixRoundGuardRequired(ControlCase):
    """H1 in CI: a fix-round pull request with no manifest cannot pass as 'nothing to protect'."""
    original = TestWeakening.original
    path = FixRoundManifest.path
    fix_round = FixRoundManifest.fix_round
    manifest = FixRoundManifest.manifest

    def record_fix_attempt(self):
        deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=20)).isoformat()
        self.cli('dispatch', '--unit', 'GRS-104/implementation', '--phase', 'initial', '--task-id', 'impl', '--deadline', deadline)
        self.cli('dispatch', '--unit', 'GRS-104/implementation', '--phase', 'fix', '--task-id', 'fix')

    def test_a_ledger_fix_event_makes_a_missing_manifest_fail(self):
        self.fix_round(self.original, manifest=False)
        self.record_fix_attempt()
        out = self.cli('fix-round-guard', '--base', 'dev', '--ledger', self.receipts,
                       '--branch', 'feature/grs-104-tooling', code=1)
        self.assertIn('fix', out)
        self.cli('fix-round-guard', '--base', 'dev', '--ledger', self.receipts, '--branch', 'feature/grs-105-other')

    def test_the_fix_round_label_makes_a_missing_manifest_fail(self):
        self.fix_round(self.original, manifest=False)
        self.assertIn('manifest', self.cli('fix-round-guard', '--base', 'dev', '--require-manifest', code=1))

    def test_a_pull_request_without_a_fix_event_passes_and_the_receipt_says_so(self):
        self.fix_round(self.original, manifest=False)
        self.cli('fix-round-guard', '--base', 'dev', '--ledger', self.receipts, '--branch', 'feature/grs-104-tooling')
        self.assertTrue(self.last_receipt()['guard']['nothingToProtect'])

    guard_with_ledger = ('fix-round-guard', '--base', 'dev', '--ledger', None, '--branch', 'feature/grs-104-tooling')

    def ledger_guard(self, code=0):
        return self.cli(*[self.receipts if word is None else word for word in self.guard_with_ledger], code=code)

    def reviewed_round(self):
        """The reviewed commit on the feature branch, its review-record and a recorded fix attempt."""
        self.pr_base = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', '-c', 'feature/grs-104-tooling')
        self.write('tests/protected.test.ts', self.original)
        self.reviewed = self.commit('reviewed tests')
        findings = self.document('review-findings.json', {
            'sha': self.reviewed, 'updatedAt': '2026-10-17T09:00:00+00:00', 'unresolvedFindings': [{'id': 'H1', 'severity': 'high'}],
            'protectedTests': [{'file': 'tests/protected.test.ts', 'name': 'rejects stale evidence'}]})
        self.findings_sha = hashlib.sha256(findings.read_bytes()).hexdigest()
        review = self.document('review.json', {'schema': 'clearcase-review/1', 'sha': self.reviewed, 'verdict': 'FAIL',
                                               'findingsSha256': self.findings_sha, 'unresolvedFindings': [{'id': 'H1', 'severity': 'high'}]})
        self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', review, '--findings', findings)
        self.record_fix_attempt()

    def test_with_the_ledger_the_fix_base_and_findings_come_from_the_recorded_review(self):
        # CI has no ledger and reads fixBase from the manifest; the coordinator's run with the ledger must not
        self.reviewed_round()
        self.write('tests/protected.test.ts', self.original.replace('.toEqual(false)', '.toBeDefined()'))
        weakened = self.commit('weaken after the review')
        for label, base, digest in (('a fix base after the weakening', weakened, self.findings_sha),
                                    ('other findings', self.reviewed, '0' * 64)):
            with self.subTest(bypass=label):
                self.base = base
                self.manifest(reviewFindingsSha256=digest)
                self.commit('manifest: ' + label)
                self.assertIn('ledger', self.ledger_guard(code=1))

    def test_with_the_ledger_a_fix_event_without_a_recorded_review_refuses(self):
        self.fix_round(self.original)
        self.record_fix_attempt()
        self.assertIn('review', self.ledger_guard(code=1))

    def test_with_the_ledger_a_manifest_naming_the_recorded_review_passes(self):
        self.reviewed_round()
        self.write('app.txt', 'fixed\n')
        self.base = self.reviewed
        self.manifest(reviewFindingsSha256=self.findings_sha)
        self.commit('fix round')
        self.ledger_guard()


class RetainedPaths(ControlCase):
    """L1 and L2."""
    prepare = ApprovalLedger.prepare
    approve = ApprovalLedger.approve

    def test_ledger_events_store_raw_receipt_paths(self):
        self.env['HOME'] = str(self.work)
        self.prepare()
        self.approve()
        events = [json.loads(line) for line in (self.receipts / 'events.jsonl').read_text().splitlines()]
        stored = [e['payload']['receipt'] for e in events if e['kind'] == 'approval']
        self.assertTrue(stored and all(path.startswith(str(self.receipts)) for path in stored), stored)

    def test_a_path_beside_home_is_not_redacted_as_home(self):
        # /home/x2 is not under /home/x: redacting it to ~2 made approval-check reopen another user's home
        self.env['HOME'] = str(self.work)[:-2]
        self.prepare(inputs=[self.document('input.txt', {'reviewed': True})])
        self.approve()
        approved = sorted(self.receipts.glob('*/receipt.json'))[-1]
        self.assertNotIn('"~', approved.read_text())
        self.cli('approval-check', '--unit', 'GRS-104/implementation', '--sha', self.sha, '--approval-receipt', approved)

    def test_a_relative_ledger_directory_refuses(self):
        self.env['CLEARCASE_LEDGER_DIR'] = '../relative-ledger'
        self.assertIn('absolute', self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', 'r.json',
                                           '--findings', 'f.json', code=1))
        del self.env['CLEARCASE_LEDGER_DIR']
        self.assertIn('absolute', self.cli('review-record', '--unit', 'GRS-104/implementation', '--review', 'r.json',
                                           '--findings', 'f.json', '--ledger', 'relative', code=1))


class ContinuousIntegrationWiring(unittest.TestCase):
    def test_pull_requests_run_the_fix_round_guard_on_their_head_under_bun(self):
        workflow = (TOOLS.parents[1] / '.github/workflows/ci.yml').read_text()
        step = workflow[workflow.index('- name: test guard'):]
        step = step[:step.index('\n      - ')]
        for needle in ("github.event_name == 'pull_request'", 'github.event.pull_request.head.sha',
                       'CLEARCASE_NODE=$(command -v bun)', 'scripts/agent-tools/fix-round-guard', 'origin/$BASE_REF'):
            self.assertIn(needle, step)

    def test_the_guard_comes_from_the_base_branch_and_a_fix_round_label_requires_a_manifest(self):
        workflow = (TOOLS.parents[1] / '.github/workflows/ci.yml').read_text()
        step = workflow[workflow.index('- name: test guard'):]
        step = step[:step.index('\n      - ')]
        for needle in ('git worktree add -q --detach "$base_tools" "origin/$BASE_REF"', 'ln -s', 'node_modules',
                       '"$base_tools/scripts/agent-tools/fix-round-guard"', '--require-manifest', "'fix-round'",
                       'github.head_ref'):
            self.assertIn(needle, step)
        self.assertNotIn('\n          CLEARCASE_NODE=$(command -v bun) scripts/agent-tools/fix-round-guard', step)

if __name__ == '__main__':
    unittest.main(verbosity=2)
