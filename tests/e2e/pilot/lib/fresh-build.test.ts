// Fresh-build evidence (fresh-build.ts) on synthetic git repositories in a temp folder: a build is fresh only when
// its stamp names HEAD, it was made in the repository's own build/ (or is the runner's own isolated build), it was not
// made from a dirty tree and no file is modified or untracked (not ignored) now; the override (the flag only) and the
// evidence record. The build stamp itself (scripts/pilot/copy-pdfjs.ts) is run on synthetic app trees: it counts
// untracked files, and a copy inside another worktree gets no revision, so it is refused. The guard fails closed: a
// working-tree state git cannot read (a corrupt index: HEAD resolves, `git status` fails), a stamp that does not parse
// or does not say whether its tree was dirty, and an app tree under test other than the repository are each refused.
// git answers for the directory itself: a copy inside another checkout or a nested repository git rejects (it walks up
// to the parent) is refused, GIT_* variables cannot point git elsewhere, untracked files show whatever
// status.showUntrackedFiles says, and tracked files flagged assume-unchanged or skip-worktree are refused. An fsmonitor
// hook cannot hide an edit, and in the build inputs only the committed .gitignore files may hide an untracked file: one
// hidden by .git/info/exclude or a global excludes file, or by a .gitignore that ignores itself, is refused. A file a
// runner reads by name is a committed review input only when tracked, unmodified and not hidden (uncommittedInputs).
// The cases that need a symlink skip, saying so in their title, where the platform refuses to create one (Windows
// without Developer Mode); every other case runs everywhere.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { ALLOW_FLAG, allowStale, evidenceRecord, evidenceSuffix, freshness, gitBlobId, gitEnv, notCommitted, readStamp, refusal, uncommittedInputs } from './fresh-build.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const BUN = process.versions.bun ? process.execPath : 'bun';

const root = mkdtempSync(join(tmpdir(), 'cc-fresh-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** Whether this process may create a symlink: Windows refuses one (EPERM) without Developer Mode or elevation. */
const canSymlink = (() => {
	try { symlinkSync(root, join(root, 'symlink-probe'), 'dir'); return true; } catch (e) { if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) return false; throw e; }
})();
/** A case that needs a symlink: skipped, with the reason in its title, where the platform refuses to create one. */
const symlinkTest = (name: string, fn: () => void) => (canSymlink ? test(name, fn) : test.skip(`${name} [skipped: this platform refuses to create symlinks]`, fn));
const git = (repo: string, ...args: string[]) => {
	const r = spawnSync('git', ['-C', repo, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
};
function repo() {
	const d = mkdtempSync(join(root, 'repo-'));
	git(d, 'init', '-q');
	writeFileSync(join(d, 'a.txt'), 'one\n');
	writeFileSync(join(d, '.gitignore'), 'ignored.txt\nbuild/\n.local/\nnode_modules\n');
	git(d, 'add', 'a.txt', '.gitignore');
	git(d, 'commit', '-q', '-m', 'synthetic');
	return { d, head: git(d, 'rev-parse', 'HEAD') };
}

describe('freshness', () => {
	test("a clean HEAD's build is fresh; an ignored file does not change that", () => {
		const { d, head } = repo();
		writeFileSync(join(d, 'ignored.txt'), 'x');
		const f = freshness(d, { revision: head, dirty: false });
		expect(f).toMatchObject({ fresh: true, buildRevision: head, head, buildDirty: false, trackedDirty: false, reasons: [] });
		expect(evidenceRecord(f, false)).toEqual({ evidence: true, freshBuild: { buildRevision: head, buildDirty: false, head, trackedDirty: false, fresh: true, reasons: [], allowStaleBuild: false } });
	});
	test('one untracked, not ignored file makes the tree dirty (a new route never git-added is evidence too)', () => {
		const { d, head } = repo();
		mkdirSync(join(d, 'src', 'routes'), { recursive: true });
		writeFileSync(join(d, 'src', 'routes', '+page.svelte'), 'new');
		const f = freshness(d, { revision: head, dirty: false });
		expect(f.fresh).toBe(false);
		expect(f.reasons).toEqual(['files are modified or untracked: src/']);
	});
	test("a build directory other than <repo>/build is stale, unless it is the runner's own isolated build", () => {
		const { d, head } = repo();
		expect(freshness(d, { revision: head, dirty: false }, { buildDir: join(d, 'build') }).fresh).toBe(true);
		const other = join(d, '.local', 'scratch', 'build');
		expect(freshness(d, { revision: head, dirty: false }, { buildDir: other }).reasons).toEqual([`the build is not ${join(d, 'build')} (it is ${other})`]);
		// isolatedBuild's result: the stamp it exported, in the directory it built
		const iso = { revision: head, buildDir: other };
		expect(freshness(d, { revision: head, dirty: false, exported: true }, { buildDir: other, isolated: iso }).fresh).toBe(true);
		expect(freshness(d, { revision: head, dirty: false, exported: false }, { buildDir: other, isolated: iso }).fresh).toBe(false);
		expect(freshness(d, { revision: head, dirty: false, exported: true }, { buildDir: other }).fresh).toBe(false);
		expect(freshness(d, { revision: head, dirty: false, exported: true }, { buildDir: other, isolated: { revision: head, buildDir: join(d, 'elsewhere') } }).fresh).toBe(false);
	});
	test('another revision, a dirty build, modified tracked files, no stamp and no repository are each stale', () => {
		const { d, head } = repo();
		const old = head;
		writeFileSync(join(d, 'a.txt'), 'two\n');
		git(d, 'commit', '-q', '-am', 'second');
		expect(freshness(d, { revision: old, dirty: false }).reasons.join()).toMatch(/the build is of [0-9a-f]{12}, not HEAD/);
		// a revision label that is not a commit id (mutate.mjs stamps its mutants so) is shown in full and never fresh
		expect(freshness(d, { revision: `mutant:export@${old}`, dirty: false }).reasons).toEqual([`the build is of mutant:export@${old}, not HEAD ${git(d, 'rev-parse', 'HEAD').slice(0, 12)}`]);
		const now = git(d, 'rev-parse', 'HEAD');
		expect(freshness(d, { revision: now, dirty: true }).reasons).toEqual(['the build was made from a tree with modified or untracked files']);
		writeFileSync(join(d, 'a.txt'), 'three\n');
		expect(freshness(d, { revision: now, dirty: false }).reasons).toEqual(['files are modified or untracked: a.txt']);
		expect(freshness(d, null).reasons[0]).toBe('no build stamp');
		expect(freshness(join(root, 'not-a-repo'), { revision: now, dirty: false }).reasons.join()).toMatch(/not a git checkout/);
	});
	test('a working-tree state git cannot establish is refused: HEAD resolves but the index is unreadable', () => {
		const { d, head } = repo();
		// the reviewer's repro: `git rev-parse HEAD` works, `git status` fails
		writeFileSync(join(d, '.git', 'index'), 'not an index\n');
		expect(git(d, 'rev-parse', 'HEAD')).toBe(head);
		const f = freshness(d, { revision: head, dirty: false });
		expect(f).toMatchObject({ fresh: false, head, trackedDirty: null });
		expect(f.reasons).toEqual([expect.stringMatching(new RegExp(`^the working-tree state of ${d} is unknown \\(git status failed: .*index`))]);
		const rec = evidenceRecord(f, false);
		expect(rec).toMatchObject({ evidence: false, freshBuild: { trackedDirty: null, fresh: false } });
		expect(rec.evidenceNote).toMatch(/^NOT release evidence \(stale build\): the working-tree state of .* is unknown \(git status failed: /);
		// HEAD unknown keeps git's reason too
		expect(freshness(join(root, 'not-a-repo'), { revision: head, dirty: false }).reasons.join('; ')).toMatch(/is not a git checkout \(HEAD unknown: .+\); the working-tree state of .* is unknown \(git status failed: .+\)/);
	});
	test('a stamp that does not parse, or does not say whether its tree was dirty, is refused', () => {
		const { d, head } = repo();
		expect(freshness(d, { revision: head }).reasons).toEqual(['the build stamp does not say whether its tree had modified or untracked files (git could not tell at build time)']);
		expect(freshness(d, { revision: head, dirty: null }).fresh).toBe(false);
		const b = join(d, '.local', 'b');
		mkdirSync(b, { recursive: true });
		expect(readStamp(b)).toBeNull();
		writeFileSync(join(b, 'clearcase-build.json'), '{"revision": "' + head + '", "dirty": fal');
		const bad = readStamp(b)!;
		expect(bad.unreadable).toMatch(/clearcase-build\.json/);
		expect(freshness(d, bad).reasons).toEqual([expect.stringMatching(/^the build stamp is unreadable \(.*clearcase-build\.json/)]);
		writeFileSync(join(b, 'clearcase-build.json'), '[1]');
		expect(freshness(d, readStamp(b)).reasons).toEqual([expect.stringMatching(/^the build stamp is unreadable \(.* is not a JSON object\)$/)]);
		writeFileSync(join(b, 'clearcase-build.json'), JSON.stringify({ revision: head, dirty: false }));
		expect(freshness(d, readStamp(b)).fresh).toBe(true);
	});
	test('an app tree under test other than the repository is refused', () => {
		const { d, head } = repo();
		mkdirSync(join(d, 'build'));
		const copy = join(root, `plain-copy-${head.slice(0, 8)}`);
		mkdirSync(copy);
		const stamp = { revision: head, dirty: false };
		expect(freshness(d, stamp, { buildDir: join(d, 'build'), appRoot: copy }).reasons).toEqual([`the app tree under test is ${copy}, not ${d} (its server entry, suites and routes would be unverified)`]);
		expect(freshness(d, stamp, { buildDir: join(d, 'build'), appRoot: d }).fresh).toBe(true);
	});
	symlinkTest('an app tree under test other than the repository is refused, also when its build/ links to <repo>/build', () => {
		const { d, head } = repo();
		mkdirSync(join(d, 'build'));
		const copy = join(root, `copy-${head.slice(0, 8)}`);
		mkdirSync(copy);
		symlinkSync(join(d, 'build'), join(copy, 'build'));
		const stamp = { revision: head, dirty: false };
		// the build directory check alone passes: the copy's build/ resolves to <repo>/build
		expect(freshness(d, stamp, { buildDir: join(copy, 'build') }).fresh).toBe(true);
		expect(freshness(d, stamp, { buildDir: join(copy, 'build'), appRoot: copy }).reasons).toEqual([`the app tree under test is ${copy}, not ${d} (its server entry, suites and routes would be unverified)`]);
		expect(freshness(d, stamp, { buildDir: join(d, 'build'), appRoot: copy }).fresh).toBe(false);
		// the repository itself, also through a symlink, is fine
		symlinkSync(d, join(root, `link-${head.slice(0, 8)}`));
		expect(freshness(d, stamp, { buildDir: join(d, 'build'), appRoot: d }).fresh).toBe(true);
		expect(freshness(d, stamp, { buildDir: join(d, 'build'), appRoot: join(root, `link-${head.slice(0, 8)}`) }).fresh).toBe(true);
	});
	symlinkTest("the repository's .gitignore ignores a symlinked node_modules, so a worktree that links it is not dirty", () => {
		const { d, head } = repo();
		copyFileSync(join(REPO, '.gitignore'), join(d, '.gitignore'));
		git(d, 'commit', '-q', '-am', 'the repository .gitignore');
		const now = git(d, 'rev-parse', 'HEAD');
		expect(now).not.toBe(head);
		mkdirSync(join(root, 'shared-modules'), { recursive: true });
		symlinkSync(join(root, 'shared-modules'), join(d, 'node_modules'));
		expect(freshness(d, { revision: now, dirty: false })).toMatchObject({ fresh: true, trackedDirty: false });
	});
	test('a run with another reason it is not evidence records evidence: false with that reason, fresh build or not', () => {
		const { d, head } = repo();
		const ok = freshness(d, { revision: head, dirty: false });
		expect(evidenceRecord(ok, false, [])).toMatchObject({ evidence: true });
		expect(evidenceRecord(ok, false, ['--app-v5-html compares v5 with a copy of itself (self-parity)'])).toMatchObject({ evidence: false, evidenceNote: 'NOT release evidence: --app-v5-html compares v5 with a copy of itself (self-parity)' });
		expect(evidenceRecord(ok, true, ['x']).evidenceNote).toBe('NOT release evidence (--allow-stale-build): the override was passed; x');
		expect(evidenceSuffix(evidenceRecord(ok, false, ['x']))).toBe(' — NOT EVIDENCE (NOT release evidence: x)');
	});
	test("a directory that is not git's top level is refused, naming the checkout git answers for (a copy, a nested repository with a corrupt HEAD)", () => {
		const { d, head } = repo();
		// a modified copy under the ignored .local/: git would answer for the clean checkout around it
		const copy = join(d, '.local', 'copy');
		mkdirSync(join(copy, 'tests'), { recursive: true });
		writeFileSync(join(copy, 'tests', 'suite.mjs'), '// modified\n');
		expect(freshness(copy, { revision: head, dirty: false }).reasons).toEqual([`${copy} is not the top level of its git checkout: git answers for ${d}`]);
		// a nested repository whose HEAD git cannot read: git walks up to the parent
		const nested = join(d, 'nested');
		git(d, 'init', '-q', 'nested');
		writeFileSync(join(nested, '.git', 'HEAD'), 'not a ref\n');
		const f = freshness(nested, { revision: head, dirty: false });
		expect(f).toMatchObject({ fresh: false, head: null, trackedDirty: null });
		expect(f.reasons).toEqual([`${nested} is not the top level of its git checkout: git answers for ${d}`]);
		expect(evidenceRecord(f, false).evidence).toBe(false);
	});
	test('GIT_WORK_TREE and GIT_DIR in the environment cannot point git at a clean clone', () => {
		const { d, head } = repo();
		const clone = join(root, `clone-${head.slice(0, 8)}`);
		git(root, 'clone', '-q', d, clone);
		writeFileSync(join(d, 'a.txt'), 'modified\n');
		const keys = ['GIT_WORK_TREE', 'GIT_DIR'] as const;
		const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		const withEnv = (env: Partial<Record<(typeof keys)[number], string>>) => {
			try { Object.assign(process.env, env); return freshness(d, { revision: head, dirty: false }); } finally { for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
		};
		expect(withEnv({ GIT_WORK_TREE: clone }).reasons).toEqual(['files are modified or untracked: a.txt']);
		expect(withEnv({ GIT_WORK_TREE: clone, GIT_DIR: join(clone, '.git') }).reasons).toEqual(['files are modified or untracked: a.txt']);
		// every GIT_* variable is dropped from git's environment, nothing else
		expect(gitEnv({ GIT_DIR: 'x', GIT_WORK_TREE: 'x', GIT_INDEX_FILE: 'x', GIT_COMMON_DIR: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no', PATH: '/bin', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
	});
	test('an untracked file is seen with status.showUntrackedFiles=no in the git config', () => {
		const { d, head } = repo();
		git(d, 'config', 'status.showUntrackedFiles', 'no');
		writeFileSync(join(d, 'untracked.ts'), 'x');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual(['files are modified or untracked: untracked.ts']);
	});
	test('a tracked file flagged assume-unchanged or skip-worktree is refused, modified or not', () => {
		const reason = (p: string) => `git is told not to look at tracked files (assume-unchanged or skip-worktree), so their changes are invisible: ${p}`;
		for (const flag of ['--assume-unchanged', '--skip-worktree']) {
			const { d, head } = repo();
			git(d, 'update-index', flag, 'a.txt');
			writeFileSync(join(d, 'a.txt'), 'modified behind git\n');
			expect(git(d, 'status', '--porcelain'), flag).toBe('');
			const f = freshness(d, { revision: head, dirty: false });
			expect(f.reasons, flag).toEqual([reason('a.txt')]);
			expect(f.fresh).toBe(false);
		}
	});
	test('an fsmonitor hook that reports no change cannot hide an edit to a tracked file', () => {
		const { d, head } = repo();
		const hook = join(root, `fsmonitor-${head.slice(0, 8)}.sh`);
		writeFileSync(hook, '#!/bin/sh\nprintf "tok\\0"\n', { mode: 0o755 });
		git(d, 'config', 'core.fsmonitor', hook);
		git(d, 'status', '--porcelain');
		writeFileSync(join(d, 'a.txt'), 'edited behind the hook\n');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual(['files are modified or untracked: a.txt']);
	});
	const locally = (ps: string) => `untracked files in the build inputs are hidden only by a local ignore rule (.git/info/exclude or a global excludes file): ${ps}`;
	test('an untracked build input hidden only by .git/info/exclude is refused, also in a linked worktree; outside the inputs it is not', () => {
		const { d, head } = repo();
		const put = (base: string, rel: string) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), 'synthetic\n'); };
		put(d, 'src/routes/new/+page.svelte');
		writeFileSync(join(d, '.git', 'info', 'exclude'), 'src/routes/new/\n');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual([locally('src/routes/new/+page.svelte')]);
		// a root file is a build input (a tool may pick it up by name); a folder outside the inputs is not
		put(d, 'postcss.config.js');
		put(d, 'notes/scratch.md');
		writeFileSync(join(d, '.git', 'info', 'exclude'), 'src/routes/new/\npostcss.config.js\nnotes/\n');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual([locally('postcss.config.js, src/routes/new/+page.svelte')]);
		// a linked worktree reads the common directory's info/exclude
		const w = join(root, `linked-${head.slice(0, 8)}`);
		git(d, 'worktree', 'add', '-q', '--detach', w, 'HEAD');
		expect(freshness(w, { revision: head, dirty: false }).fresh).toBe(true);
		put(w, 'src/routes/new/+page.svelte');
		expect(git(w, 'status', '--porcelain')).toBe('');
		expect(freshness(w, { revision: head, dirty: false }).reasons).toEqual([locally('src/routes/new/+page.svelte')]);
	});
	test('an untracked build input hidden only by a global excludes file is refused (an isolated HOME and XDG_CONFIG_HOME, a repository core.excludesFile)', () => {
		const { d, head } = repo();
		const xdg = join(root, `xdg-${head.slice(0, 8)}`);
		mkdirSync(join(xdg, 'git'), { recursive: true });
		writeFileSync(join(xdg, 'git', 'ignore'), '*.swp\n');
		mkdirSync(join(d, 'src'));
		writeFileSync(join(d, 'src', '.page.svelte.swp'), 'synthetic\n');
		const was = process.env.XDG_CONFIG_HOME;
		const originalHome = process.env.HOME;
		try {
			process.env.HOME = xdg;
			process.env.XDG_CONFIG_HOME = xdg;
			expect(git(d, 'status', '--porcelain')).toBe('');
			expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual([locally('src/.page.svelte.swp')]);
		} finally {
			if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was;
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		}
		git(d, 'config', 'core.excludesFile', join(xdg, 'git', 'ignore'));
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual([locally('src/.page.svelte.swp')]);
	});
	test('an untracked folder whose own .gitignore ignores everything, itself included, is refused', () => {
		const { d, head } = repo();
		mkdirSync(join(d, 'src', 'routes', 'sneak'), { recursive: true });
		writeFileSync(join(d, 'src', 'routes', 'sneak', '.gitignore'), '*\n');
		writeFileSync(join(d, 'src', 'routes', 'sneak', '+page.svelte'), 'synthetic\n');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(freshness(d, { revision: head, dirty: false }).reasons).toEqual(['untracked .gitignore files in the build inputs ignore themselves and hide their folder: src/routes/sneak/.gitignore']);
	});
	test('the override is the flag only: an exported CLEARCASE_ALLOW_STALE_BUILD does nothing', () => {
		expect(allowStale([ALLOW_FLAG])).toBe(true);
		expect(allowStale([])).toBe(false);
		const was = process.env.CLEARCASE_ALLOW_STALE_BUILD;
		process.env.CLEARCASE_ALLOW_STALE_BUILD = '1';
		try { expect(allowStale([])).toBe(false); } finally { if (was === undefined) delete process.env.CLEARCASE_ALLOW_STALE_BUILD; else process.env.CLEARCASE_ALLOW_STALE_BUILD = was; }
	});
	test('the evidence record, the NOT EVIDENCE suffix and the refusal say what is stale and what to do', () => {
		const f = freshness(join(root, 'not-a-repo'), null);
		const rec = evidenceRecord(f, true);
		expect(rec.evidence).toBe(false);
		expect(rec.freshBuild.allowStaleBuild).toBe(true);
		expect(rec.evidenceNote).toMatch(/^NOT release evidence \(--allow-stale-build\): no build stamp/);
		expect(evidenceSuffix(rec)).toMatch(/^ — NOT EVIDENCE \(NOT release evidence/);
		expect(refusal('parity', f)).toMatch(/^parity: stale build \(no build stamp; .*\): git add and commit every change \(move scratch files to \.local\/\), then run `bun run --bun build` in the repository itself, then rerun \(or pass --allow-stale-build for a non-evidence run\)$/);
		// the override makes even a fresh build's run non-evidence
		const { d, head } = repo();
		const ok = freshness(d, { revision: head, dirty: false });
		expect(evidenceRecord(ok, false).evidence).toBe(true);
		expect(evidenceSuffix(evidenceRecord(ok, false))).toBe('');
		expect(evidenceRecord(ok, true)).toMatchObject({ evidence: false, evidenceNote: 'NOT release evidence (--allow-stale-build): the override was passed' });
	});
});

describe('committed review inputs (uncommittedInputs)', () => {
	test('a tracked, unmodified file counts; an ignored, untracked, modified, staged, hidden or outside file does not, each named with why', () => {
		const { d } = repo();
		mkdirSync(join(d, 'p', '.local'), { recursive: true });
		for (const f of ['tracked.json', 'changed.json', 'hidden.json']) writeFileSync(join(d, 'p', f), '{}');
		git(d, 'add', 'p');
		git(d, 'commit', '-q', '-m', 'p');
		writeFileSync(join(d, 'p', '.local', 'over.json'), '{}');
		writeFileSync(join(d, 'p', 'new.json'), '{}');
		writeFileSync(join(d, 'p', 'staged.json'), '{}');
		git(d, 'add', 'p/staged.json');
		writeFileSync(join(d, 'p', 'changed.json'), '{"x":1}');
		git(d, 'update-index', '--assume-unchanged', 'p/hidden.json');
		writeFileSync(join(d, 'p', 'hidden.json'), '{"x":1}');
		const outside = join(root, 'outside.json');
		writeFileSync(outside, '{}');
		const at = (...n: string[]) => n.map((x) => join(d, 'p', x));
		expect(uncommittedInputs(d, at('tracked.json'))).toEqual([]);
		expect(uncommittedInputs(d, [...at('tracked.json', '.local/over.json', 'new.json', 'staged.json', 'changed.json', 'hidden.json'), outside])).toEqual([
			'p/.local/over.json (ignored)',
			'p/new.json (untracked)',
			'p/staged.json (modified)',
			'p/changed.json (modified)',
			'p/hidden.json (hidden from git (assume-unchanged or skip-worktree))',
			`${realpathSync(outside)} (outside the checkout ${realpathSync(d)})`,
		]);
		expect(notCommitted('register files', d, at('tracked.json'))).toEqual([]);
		expect(notCommitted('register files', d, at('tracked.json', 'new.json'))).toEqual(['register files that the reviewed commit does not hold: p/new.json (untracked)']);
	});
	symlinkTest('a tracked symlink is judged as given and as resolved (here to an ignored file), and its target is not its HEAD blob', () => {
		const { d } = repo();
		mkdirSync(join(d, '.local'));
		writeFileSync(join(d, '.local', 'over.json'), '{}');
		symlinkSync(join('.local', 'over.json'), join(d, 'link.json'));
		git(d, 'add', 'link.json');
		git(d, 'commit', '-q', '-m', 'link');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(uncommittedInputs(d, [join(d, 'link.json')])).toEqual(["link.json (resolves to .local/over.json, which is ignored; its bytes are not HEAD's)"]);
	});
	test('git answers for the directory itself: a subfolder of a checkout, a folder outside any, and GIT_* variables pointing elsewhere', () => {
		const { d } = repo();
		mkdirSync(join(d, 'sub'));
		writeFileSync(join(d, 'sub', 'x.json'), '{}');
		git(d, 'add', 'sub');
		git(d, 'commit', '-q', '-m', 'sub');
		expect(uncommittedInputs(d, [join(d, 'sub', 'x.json')])).toEqual([]);
		expect(uncommittedInputs(join(d, 'sub'), [join(d, 'sub', 'x.json')])).toEqual([`x.json (unknown: ${realpathSync(join(d, 'sub'))} is not the top level of its git checkout)`]);
		const plain = mkdtempSync(join(root, 'plain-'));
		writeFileSync(join(plain, 'x.json'), '{}');
		expect(uncommittedInputs(plain, [join(plain, 'x.json')])).toEqual([expect.stringMatching(/^x\.json \(unknown: .*not a git repository/)]);
		// a repository where the file is tracked, named through GIT_DIR and GIT_WORK_TREE, changes nothing
		const other = repo().d;
		writeFileSync(join(other, 'new.json'), '{}');
		git(other, 'add', 'new.json');
		git(other, 'commit', '-q', '-m', 'new');
		const { d: e } = repo();
		writeFileSync(join(e, 'new.json'), '{}');
		const was = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(other, '.git');
		process.env.GIT_WORK_TREE = e;
		try { expect(uncommittedInputs(e, [join(e, 'new.json')])).toEqual(['new.json (untracked)']); } finally {
			if (was.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = was.dir;
			if (was.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = was.tree;
		}
	});
	test("the bytes must be HEAD's blob at the path as given: an edit git's index does not show, the bytes a runner read, a file outside `within`", () => {
		const { d } = repo();
		const a = join(d, 'a.txt');
		// git's own blob id, without filters
		expect(gitBlobId(readFileSync(a))).toBe(git(d, 'hash-object', '--no-filters', 'a.txt'));
		expect(uncommittedInputs(d, [a])).toEqual([]);
		// the bytes the runner read count, not the file now
		expect(uncommittedInputs(d, [a], { read: { [a]: Buffer.from('two\n') } })).toEqual(["a.txt (its bytes are not HEAD's)"]);
		expect(uncommittedInputs(d, [a], { within: 'p' })).toEqual(['a.txt (outside p/)']);
		// a same-size edit with the old mtime restored and core.trustctime=false: git status is clean, the bytes are not HEAD's
		const old = 86_400; // an mtime long before the index write, in seconds
		utimesSync(a, old, old);
		git(d, 'update-index', '-q', '--refresh');
		writeFileSync(a, 'two\n');
		utimesSync(a, old, old);
		git(d, 'config', 'core.trustctime', 'false');
		expect(git(d, 'status', '--porcelain')).toBe('');
		expect(uncommittedInputs(d, [a])).toEqual(["a.txt (its bytes are not HEAD's)"]);
		// a file tracked in the index but not in HEAD is staged, so modified; one in neither is untracked
		expect(uncommittedInputs(d, [join(d, 'nowhere.json')])).toEqual(['nowhere.json (untracked)']);
	});
});

describe('the build stamp (scripts/pilot/copy-pdfjs.ts)', () => {
	/** A minimal app tree copy-pdfjs can stamp: the script and the guard it reads git with, the viewer files, pdfjs-dist (linked, or copied where symlinks are refused) and a vite build. */
	function appTree(d: string) {
		mkdirSync(join(d, 'scripts', 'pilot'), { recursive: true });
		copyFileSync(join(REPO, 'scripts', 'pilot', 'copy-pdfjs.ts'), join(d, 'scripts', 'pilot', 'copy-pdfjs.ts'));
		mkdirSync(join(d, 'tests', 'e2e', 'pilot', 'lib'), { recursive: true });
		copyFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'), join(d, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'));
		copyFileSync(join(REPO, 'scripts', 'browser-lock.mjs'), join(d, 'scripts', 'browser-lock.mjs'));
		const viewer = join('src', 'lib', 'local-case', 'viewer');
		mkdirSync(join(d, viewer), { recursive: true });
		for (const f of ['viewer.mjs', 'viewer.css', 'wrapper.mjs', 'frame.html']) copyFileSync(join(REPO, viewer, f), join(d, viewer, f));
		mkdirSync(join(d, 'node_modules'), { recursive: true });
		const pdfjs = join(REPO, 'node_modules', 'pdfjs-dist');
		if (canSymlink) symlinkSync(pdfjs, join(d, 'node_modules', 'pdfjs-dist'));
		else cpSync(pdfjs, join(d, 'node_modules', 'pdfjs-dist'), { recursive: true });
		mkdirSync(join(d, 'build'), { recursive: true });
		writeFileSync(join(d, 'build', 'handler.js'), '// synthetic\n');
		return d;
	}
	const stamp = (d: string, env: Record<string, string> = {}) => {
		const r = spawnSync(BUN, [join(d, 'scripts', 'pilot', 'copy-pdfjs.ts')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CLEARCASE_SOURCE_REVISION: '', ...env } });
		if (r.status !== 0) throw new Error(r.stderr);
		return JSON.parse(readFileSync(join(d, 'build', 'clearcase-build.json'), 'utf8'));
	};
	/** copy-pdfjs with CLEARCASE_SOURCE_REVISION unset. */
	const noEnv = (d: string) => stampEnv(d, {});
	const { d, head } = repo();
	appTree(d);
	git(d, 'add', '.');
	git(d, 'commit', '-q', '-m', 'app tree');
	const HEAD = git(d, 'rev-parse', 'HEAD');

	test('a clean checkout: HEAD, not dirty, fresh; one untracked file: dirty and refused', () => {
		expect(head).not.toBe(HEAD);
		const s = noEnv(d);
		expect(s).toMatchObject({ revision: HEAD, dirty: false, exported: false });
		expect(freshness(d, s, { buildDir: join(d, 'build') }).fresh).toBe(true);
		writeFileSync(join(d, 'untracked.ts'), 'x');
		try {
			const t = noEnv(d);
			expect(t).toMatchObject({ revision: HEAD, dirty: true });
			// dirty is computed from git even when the revision is exported
			expect(stamp(d, { CLEARCASE_SOURCE_REVISION: HEAD })).toMatchObject({ revision: HEAD, dirty: true, exported: true });
			rmSync(join(d, 'untracked.ts'));
			expect(freshness(d, t, { buildDir: join(d, 'build') }).reasons).toEqual(['the build was made from a tree with modified or untracked files']);
		} finally { rmSync(join(d, 'untracked.ts'), { force: true }); }
	});
	test('a checkout whose working-tree state git cannot read stamps dirty: null, which is refused', () => {
		const { d: e } = repo();
		appTree(e);
		git(e, 'add', '.');
		git(e, 'commit', '-q', '-m', 'app tree');
		const at = git(e, 'rev-parse', 'HEAD');
		writeFileSync(join(e, '.git', 'index'), 'not an index\n');
		const s = noEnv(e);
		expect(s).toMatchObject({ revision: at, dirty: null, exported: false });
		const f = freshness(e, s, { buildDir: join(e, 'build') });
		expect(f.fresh).toBe(false);
		expect(f.reasons).toContain('the build stamp does not say whether its tree had modified or untracked files (git could not tell at build time)');
		// an exported revision does not paper over it
		expect(stamp(e, { CLEARCASE_SOURCE_REVISION: at })).toMatchObject({ revision: at, dirty: null, exported: true });
	});
	/** copy-pdfjs with CLEARCASE_SOURCE_REVISION unset and `env` added. */
	const stampEnv = (d: string, env: Record<string, string>) => {
		const e: NodeJS.ProcessEnv = { ...process.env, ...env };
		delete e.CLEARCASE_SOURCE_REVISION;
		const r = spawnSync(BUN, [join(d, 'scripts', 'pilot', 'copy-pdfjs.ts')], { encoding: 'utf8', timeout: 60_000, env: e });
		if (r.status !== 0) throw new Error(r.stderr);
		return JSON.parse(readFileSync(join(d, 'build', 'clearcase-build.json'), 'utf8'));
	};
	/** A fresh committed app tree in its own repository. */
	const appRepo = () => { const { d: e } = repo(); appTree(e); git(e, 'add', '.'); git(e, 'commit', '-q', '-m', 'app tree'); return { e, at: git(e, 'rev-parse', 'HEAD') }; };
	test('the stamp asks git about the app tree itself: GIT_DIR and GIT_WORK_TREE pointing at a clean clone change nothing', () => {
		const { e, at } = appRepo();
		const clone = join(root, `app-clone-${at.slice(0, 8)}`);
		git(root, 'clone', '-q', e, clone);
		writeFileSync(join(e, 'untracked.ts'), 'x');
		expect(stampEnv(e, { GIT_DIR: join(clone, '.git'), GIT_WORK_TREE: clone })).toMatchObject({ revision: at, dirty: true, exported: false });
		expect(stampEnv(e, { GIT_WORK_TREE: clone })).toMatchObject({ revision: at, dirty: true });
	});
	test('the stamp sees untracked files with status.showUntrackedFiles=no, and stamps dirty: null for an assume-unchanged file', () => {
		const { e, at } = appRepo();
		git(e, 'config', 'status.showUntrackedFiles', 'no');
		writeFileSync(join(e, 'untracked.ts'), 'x');
		expect(noEnv(e)).toMatchObject({ revision: at, dirty: true });
		rmSync(join(e, 'untracked.ts'));
		expect(noEnv(e)).toMatchObject({ revision: at, dirty: false });
		git(e, 'update-index', '--assume-unchanged', 'a.txt');
		writeFileSync(join(e, 'a.txt'), 'modified behind git\n');
		const s = noEnv(e);
		expect(s).toMatchObject({ revision: at, dirty: null });
		expect(freshness(e, s, { buildDir: join(e, 'build') }).fresh).toBe(false);
	});
	test('the stamp skips the fsmonitor hook and counts build inputs that only a local rule or a self-ignoring .gitignore hides', () => {
		const hooked = appRepo();
		const hook = join(root, `stamp-fsmonitor-${hooked.at.slice(0, 8)}.sh`);
		writeFileSync(hook, '#!/bin/sh\nprintf "tok\\0"\n', { mode: 0o755 });
		git(hooked.e, 'config', 'core.fsmonitor', hook);
		git(hooked.e, 'status', '--porcelain');
		writeFileSync(join(hooked.e, 'a.txt'), 'edited behind the hook\n');
		expect(noEnv(hooked.e)).toMatchObject({ revision: hooked.at, dirty: true });
		const excluded = appRepo();
		mkdirSync(join(excluded.e, 'src', 'routes', 'new'), { recursive: true });
		writeFileSync(join(excluded.e, 'src', 'routes', 'new', '+page.svelte'), 'synthetic\n');
		writeFileSync(join(excluded.e, '.git', 'info', 'exclude'), 'src/routes/new/\n');
		expect(noEnv(excluded.e)).toMatchObject({ revision: excluded.at, dirty: true });
		const sneaky = appRepo();
		mkdirSync(join(sneaky.e, 'src', 'routes', 'sneak'), { recursive: true });
		writeFileSync(join(sneaky.e, 'src', 'routes', 'sneak', '.gitignore'), '*\n');
		writeFileSync(join(sneaky.e, 'src', 'routes', 'sneak', '+page.svelte'), 'synthetic\n');
		expect(noEnv(sneaky.e)).toMatchObject({ revision: sneaky.at, dirty: true });
	});
	test('a modified copy under .local/ gets no revision and is refused, also when it exports one by hand', () => {
		const copy = appTree(join(d, '.local', 'scratch'));
		writeFileSync(join(copy, 'src', 'lib', 'local-case', 'viewer', 'viewer.css'), '/* modified */\n');
		const s = noEnv(copy);
		expect(s).toMatchObject({ revision: null, dirty: false, exported: false });
		const f = freshness(d, s, { buildDir: join(copy, 'build') });
		expect(f.fresh).toBe(false);
		expect(f.reasons).toEqual(['the build stamp names no revision', `the build is not ${join(d, 'build')} (it is ${join(copy, 'build')})`]);
		const byHand = stamp(copy, { CLEARCASE_SOURCE_REVISION: HEAD });
		expect(byHand).toMatchObject({ revision: HEAD, exported: true });
		expect(freshness(d, byHand, { buildDir: join(copy, 'build') }).reasons).toEqual([`the build is not ${join(d, 'build')} (it is ${join(copy, 'build')})`]);
	});
});
