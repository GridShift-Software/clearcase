// Fresh-build evidence (fresh-build.ts) on synthetic git repositories in a temp folder: a build is fresh only when
// its stamp names HEAD, it was made in the repository's own build/ (or is the runner's own isolated build), it was not
// made from a dirty tree and no file is modified or untracked (not ignored) now; the override (the flag only) and the
// evidence record. The build stamp itself (scripts/pilot/copy-pdfjs.ts) is run on synthetic app trees: it counts
// untracked files, and a copy inside another worktree gets no revision, so it is refused. The guard fails closed: a
// working-tree state git cannot read (a corrupt index: HEAD resolves, `git status` fails), a stamp that does not parse
// or does not say whether its tree was dirty, and an app tree under test other than the repository are each refused.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { ALLOW_FLAG, allowStale, evidenceRecord, evidenceSuffix, freshness, readStamp, refusal } from './fresh-build.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const BUN = process.versions.bun ? process.execPath : 'bun';

const root = mkdtempSync(join(tmpdir(), 'cc-fresh-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
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
	test('an app tree under test other than the repository is refused, also when its build/ links to <repo>/build', () => {
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
	test("the repository's .gitignore ignores a symlinked node_modules, so a worktree that links it is not dirty", () => {
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

describe('the build stamp (scripts/pilot/copy-pdfjs.ts)', () => {
	/** A minimal app tree copy-pdfjs can stamp: the script, the viewer files, pdfjs-dist (linked) and a vite build. */
	function appTree(d: string) {
		mkdirSync(join(d, 'scripts', 'pilot'), { recursive: true });
		copyFileSync(join(REPO, 'scripts', 'pilot', 'copy-pdfjs.ts'), join(d, 'scripts', 'pilot', 'copy-pdfjs.ts'));
		const viewer = join('src', 'lib', 'local-case', 'viewer');
		mkdirSync(join(d, viewer), { recursive: true });
		for (const f of ['viewer.mjs', 'viewer.css', 'wrapper.mjs', 'frame.html']) copyFileSync(join(REPO, viewer, f), join(d, viewer, f));
		mkdirSync(join(d, 'node_modules'), { recursive: true });
		symlinkSync(join(REPO, 'node_modules', 'pdfjs-dist'), join(d, 'node_modules', 'pdfjs-dist'));
		mkdirSync(join(d, 'build'), { recursive: true });
		writeFileSync(join(d, 'build', 'handler.js'), '// synthetic\n');
		return d;
	}
	const stamp = (d: string, env: Record<string, string> = {}) => {
		const r = spawnSync(BUN, [join(d, 'scripts', 'pilot', 'copy-pdfjs.ts')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CLEARCASE_SOURCE_REVISION: '', ...env } });
		if (r.status !== 0) throw new Error(r.stderr);
		return JSON.parse(readFileSync(join(d, 'build', 'clearcase-build.json'), 'utf8'));
	};
	const noEnv = (d: string) => { const r = spawnSync('env', ['-u', 'CLEARCASE_SOURCE_REVISION', BUN, join(d, 'scripts', 'pilot', 'copy-pdfjs.ts')], { encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(readFileSync(join(d, 'build', 'clearcase-build.json'), 'utf8')); };
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
