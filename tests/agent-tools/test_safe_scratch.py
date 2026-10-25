"""The owned scratch helper (scripts/agent-tools/safe-scratch): create, and removal at an exact path with a token.
Every checkout here is synthetic, under a private mkdtemp directory that the test creates and removes; no real
/tmp entry or checkout is read or changed. The shared-prefix and real-scratch cases are not run. Run with python3 -I."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'agent-tools' / 'safe-scratch'
# -I leaves the script's directory off sys.path, and the script has no .py suffix, so load it from its path
_loader = importlib.machinery.SourceFileLoader('safe_scratch', str(SCRIPT))
scratch = importlib.util.module_from_spec(importlib.util.spec_from_loader('safe_scratch', _loader))
_loader.exec_module(scratch)
Refused = scratch.Refused
MARKER = scratch.MARKER


class ScratchCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='safe-scratch-test-')).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / 'checkout'
        self.repo.mkdir()
        self.root = self.repo / '.local' / 'agent-scratch'

    def make(self, label='alpha'):
        path, token = scratch.create_scratch(self.repo, label)
        return Path(path), token

    def remove(self, path, token, **kwargs):
        return scratch.remove_scratch(self.repo, str(path), token, **kwargs)


class CreateTests(ScratchCase):
    def test_create_writes_marker_without_the_token(self):
        path, token = self.make()
        self.assertEqual(path.parent, self.root)
        self.assertRegex(path.name, r'alpha-[0-9a-f]{16}')
        self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o700)
        text = (path / MARKER).read_text()
        self.assertNotIn(token, text)
        marker = json.loads(text)
        self.assertEqual((marker['worktree'], marker['uid']), (str(self.repo), os.getuid()))

    def test_create_refuses_bad_labels_before_touching_disk(self):
        for label in ['', 'Alpha', 'a/b', '../x', 'a*', '-x', 'a.b', 'a b', 'a' * 41]:
            with self.subTest(label=label), self.assertRaises(Refused):
                scratch.create_scratch(self.repo, label)
        self.assertFalse((self.repo / '.local').exists())
        self.make('a' * 40)  # the longest allowed label

    def test_create_leaves_an_existing_local_directory_unchanged(self):
        (self.repo / '.local').mkdir()
        os.chmod(self.repo / '.local', 0o750)
        self.make()
        self.assertEqual(stat.S_IMODE((self.repo / '.local').stat().st_mode), 0o750)


class RemoveTests(ScratchCase):
    def test_exact_path_and_token_remove_only_that_directory(self):
        target, token = self.make('alpha')
        other, other_token = self.make('alpha')
        beta, _ = self.make('beta')
        (self.root / 'keep.txt').write_text('keep')
        (self.root / 'alpha-note').mkdir()  # a neighbour that shares the label but has no generated name
        self.remove(target, token)
        self.assertFalse(target.exists())
        for kept in (other, beta, self.root / 'keep.txt', self.root / 'alpha-note'):
            self.assertTrue(kept.exists(), kept)
        self.remove(other, other_token)
        self.assertFalse(other.exists())

    def test_wrong_or_empty_token_is_refused(self):
        path, token = self.make()
        for bad in ('', 'wrong', token + 'x'):
            with self.subTest(token=bad), self.assertRaises(Refused):
                self.remove(path, bad)
        self.assertTrue(path.is_dir())

    def test_paths_that_are_not_one_exact_child_are_refused(self):
        target, token = self.make()
        outside = self.tmp / 'outside' / f'alpha-{"0" * 16}'
        outside.mkdir(parents=True)
        candidates = [
            str(self.root), str(self.repo / '.local'), str(self.repo), str(self.root / 'alpha-*'),
            str(self.root / ('alpha-' + '?' * 16)), str(self.root / 'alpha-'), str(self.root / 'alpha'),
            str(self.root / target.name[:-1]), str(target) + '/', str(target / MARKER),
            str(self.root / '..' / 'agent-scratch' / target.name), str(outside), target.name,
            'relative/' + target.name, '', str(self.root / target.name / '..'),
        ]
        for candidate in candidates:
            with self.subTest(path=candidate), self.assertRaises(Refused):
                self.remove(candidate, token)
        self.assertTrue(target.is_dir())
        self.assertTrue(outside.is_dir())

    def test_symlink_aliases_are_refused_and_not_followed(self):
        target, token = self.make()
        os.symlink(self.root, self.repo / 'alias')
        with self.assertRaises(Refused):
            self.remove(self.repo / 'alias' / target.name, token)
        link = self.root / 'alpha-0123456789abcdef'
        os.symlink(target, link)
        with self.assertRaises(Refused):
            self.remove(link, token)
        self.assertTrue(target.is_dir())
        self.assertTrue(link.is_symlink())

    def test_linked_ancestors_are_refused_for_create_and_remove(self):
        target, token = self.make()
        elsewhere = self.tmp / 'elsewhere'
        elsewhere.mkdir()
        os.rename(self.repo / '.local', self.tmp / 'moved')
        os.symlink(elsewhere, self.repo / '.local')
        with self.assertRaises(Refused):
            scratch.create_scratch(self.repo, 'beta')
        with self.assertRaises(Refused):
            self.remove(target, token)  # the literal path now runs through the linked .local
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertTrue((self.tmp / 'moved' / 'agent-scratch' / target.name).is_dir())

    def test_linked_scratch_root_is_refused_for_create(self):
        (self.repo / '.local').mkdir()
        elsewhere = self.tmp / 'elsewhere'
        elsewhere.mkdir()
        os.symlink(elsewhere, self.root)
        with self.assertRaises(Refused):
            scratch.create_scratch(self.repo, 'beta')
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_tampered_or_foreign_markers_are_refused(self):
        target, token = self.make()
        marker_path = target / MARKER
        original = json.loads(marker_path.read_text())
        changes = {
            'other worktree': {'worktree': str(self.tmp / 'other')},
            'other user': {'uid': os.getuid() + 1},
            'other directory name': {'name': 'alpha-0123456789abcdef'},
            'other label': {'label': 'beta'},
            'other schema': {'schema': 'something-else'},
            'other identity': {'ino': original['ino'] + 1},
            'other token': {'token_sha256': scratch.digest('someone-else')},
        }
        for why, change in changes.items():
            with self.subTest(why):
                marker_path.write_text(json.dumps({**original, **change}))
                with self.assertRaises(Refused):
                    self.remove(target, token)
                self.assertTrue(target.is_dir())
        marker_path.write_text(json.dumps(original))
        self.remove(target, token)  # the restored marker is accepted again
        self.assertFalse(target.exists())

    def test_missing_or_linked_marker_is_refused(self):
        target, token = self.make()
        (target / MARKER).unlink()
        with self.assertRaises(Refused):
            self.remove(target, token)
        self.assertTrue(target.is_dir())
        copy = self.tmp / 'copy.json'
        copy.write_text(json.dumps({'schema': scratch.SCHEMA}))
        os.symlink(copy, target / MARKER)
        with self.assertRaises(Refused):
            self.remove(target, token)
        self.assertTrue(target.is_dir())

    def test_replaced_directory_is_refused(self):
        target, token = self.make()
        target.rename(self.tmp / 'saved')
        target.mkdir()
        (target / 'foreign.txt').write_text('mine')
        with self.assertRaises(Refused):
            self.remove(target, token)
        self.assertTrue((target / 'foreign.txt').exists())
        self.assertTrue((self.tmp / 'saved').is_dir())

    def test_replacement_during_the_check_is_refused_and_nothing_is_removed(self):
        target, token = self.make()
        moved = self.tmp / 'moved'

        def swap():
            target.rename(moved)
            target.mkdir()
            (target / 'foreign.txt').write_text('mine')

        with self.assertRaisesRegex(Refused, 'replaced during the check'):
            self.remove(target, token, before_remove=swap)
        self.assertTrue((target / 'foreign.txt').exists())
        self.assertTrue(moved.is_dir())

    def test_failed_removal_leaves_neighbours_and_reports_failed(self):
        target, token = self.make('alpha')
        neighbour, neighbour_token = self.make('alpha')
        (target / 'payload.txt').write_text('x')

        def partial(dir_fd, keep=(), depth=0):
            os.unlink('payload.txt', dir_fd=dir_fd)  # part of the target goes, then the removal fails
            raise OSError(13, 'Permission denied')

        stderr = io.StringIO()
        with mock.patch.object(scratch, 'remove_entries', side_effect=partial), \
                mock.patch.object(scratch, 'REPO', self.repo), contextlib.redirect_stderr(stderr):
            code = scratch.main(['remove', str(target), '--token', token])
        self.assertEqual(code, 1)
        self.assertIn('FAILED', stderr.getvalue())
        self.assertTrue(neighbour.is_dir())
        self.remove(neighbour, neighbour_token)
        self.assertFalse(neighbour.exists())


    def test_swap_inside_the_removal_call_removes_nothing_foreign(self):
        """The name is swapped for a foreign directory on the first removal call, after every check has passed. The
        removal must stay on the checked directory: the foreign tree, its neighbours and a link target survive."""
        target, token = self.make('alpha')
        neighbour, neighbour_token = self.make('alpha')
        bystander = self.tmp / 'bystander'
        bystander.mkdir()
        (bystander / 'kept.txt').write_text('kept')
        (target / 'owned.txt').write_text('owned')
        (target / 'sub' / 'deep').mkdir(parents=True)
        (target / 'sub' / 'deep' / 'owned.txt').write_text('owned')
        os.symlink(bystander, target / 'sub' / 'link')  # removed as a link, never followed
        victim = self.tmp / 'victim'
        (victim / 'inner').mkdir(parents=True)
        (victim / 'precious.txt').write_text('precious')
        (victim / 'inner' / 'precious.txt').write_text('precious')
        (self.root / 'keep.txt').write_text('keep')
        moved = self.tmp / 'moved'
        tripped = []

        def swap():
            if not tripped:
                tripped.append(True)
                target.rename(moved)
                victim.rename(target)

        def first(real):
            def call(*args, **kwargs):
                swap()
                return real(*args, **kwargs)
            return call

        # Whichever primitive the removal reaches first swaps the name, then runs as it would have
        primitives = [(shutil, 'rmtree'), (os, 'listdir'), (os, 'scandir'), (os, 'unlink'), (os, 'rmdir')]
        stderr = io.StringIO()
        with contextlib.ExitStack() as stack:
            for owner, attr in primitives:
                stack.enter_context(mock.patch.object(owner, attr, first(getattr(owner, attr))))
            stack.enter_context(mock.patch.object(scratch, 'REPO', self.repo))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            code = scratch.main(['remove', str(target), '--token', token])
        self.assertTrue(tripped)
        # The foreign tree that took the name, the neighbours and the link target are untouched
        self.assertEqual((target / 'precious.txt').read_text(), 'precious')
        self.assertEqual((target / 'inner' / 'precious.txt').read_text(), 'precious')
        self.assertEqual((bystander / 'kept.txt').read_text(), 'kept')
        self.assertTrue(neighbour.is_dir())
        self.assertTrue((self.root / 'keep.txt').exists())
        # The checked directory is the one that was emptied, and the report says what is left
        self.assertEqual(code, 1)
        self.assertIn('FAILED', stderr.getvalue())
        self.assertIn('replaced', stderr.getvalue())
        self.assertFalse((moved / 'owned.txt').exists())
        self.assertFalse((moved / 'sub').exists())
        self.assertTrue((moved / MARKER).is_file())  # kept to the end, so the failure is visible
        # With no swap, a nested tree with a link goes, and the link target stays
        self.remove(neighbour, neighbour_token)
        again, again_token = self.make('alpha')
        (again / 'sub').mkdir()
        os.symlink(bystander, again / 'sub' / 'link')
        (again / 'sub' / 'file.txt').write_text('x')
        self.remove(again, again_token)
        self.assertFalse(again.exists())
        self.assertEqual((bystander / 'kept.txt').read_text(), 'kept')


class CliTests(ScratchCase):
    def test_cli_round_trip_in_a_copied_checkout(self):
        copy = self.tmp / 'copy'
        (copy / 'scripts' / 'agent-tools').mkdir(parents=True)
        tool = copy / 'scripts' / 'agent-tools' / 'safe-scratch'
        shutil.copy(SCRIPT, tool)

        def run(*args):
            return subprocess.run([sys.executable, '-I', str(tool), *args], capture_output=True, text=True)

        made = run('create', 'cli')
        self.assertEqual(made.returncode, 0, made.stderr)
        path = next(line[len('path: '):] for line in made.stdout.splitlines() if line.startswith('path: '))
        token = next(line[len('token: '):] for line in made.stdout.splitlines() if line.startswith('token: '))
        self.assertTrue(path.startswith(str(copy.resolve() / '.local' / 'agent-scratch' / 'cli-')))
        refused = run('remove', path, '--token', 'wrong')
        self.assertEqual(refused.returncode, 1)
        self.assertIn('REFUSED', refused.stderr)
        self.assertNotIn(token, refused.stdout + refused.stderr)
        self.assertTrue(os.path.isdir(path))
        removed = run('remove', path, '--token', token)
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(os.path.exists(path))


if __name__ == '__main__':
    unittest.main()
