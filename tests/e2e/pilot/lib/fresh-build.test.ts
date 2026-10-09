// Fresh-build evidence (fresh-build.ts) on synthetic git repositories in a temp folder: a build is fresh only when
// its stamp names HEAD, it was not made from a dirty tree and no tracked file is modified now (untracked files do not
// count, as in the build stamp); the override and the evidence record.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { ALLOW_ENV, ALLOW_FLAG, allowStale, evidenceRecord, freshness, refusal } from './fresh-build.ts';

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
	git(d, 'add', 'a.txt');
	git(d, 'commit', '-q', '-m', 'synthetic');
	return { d, head: git(d, 'rev-parse', 'HEAD') };
}

describe('freshness', () => {
	test("a clean HEAD's build is fresh; an untracked file does not change that", () => {
		const { d, head } = repo();
		writeFileSync(join(d, 'untracked.txt'), 'x');
		const f = freshness(d, { revision: head, dirty: false });
		expect(f).toMatchObject({ fresh: true, buildRevision: head, head, buildDirty: false, trackedDirty: false, reasons: [] });
		expect(evidenceRecord(f, false)).toEqual({ evidence: true, freshBuild: { buildRevision: head, buildDirty: false, head, trackedDirty: false, fresh: true, reasons: [], allowStaleBuild: false } });
	});
	test('another revision, a dirty build, modified tracked files, no stamp and no repository are each stale', () => {
		const { d, head } = repo();
		const old = head;
		writeFileSync(join(d, 'a.txt'), 'two\n');
		git(d, 'commit', '-q', '-am', 'second');
		expect(freshness(d, { revision: old }).reasons.join()).toMatch(/the build is of .{12}, not HEAD/);
		const now = git(d, 'rev-parse', 'HEAD');
		expect(freshness(d, { revision: now, dirty: true }).reasons).toEqual(['the build was made from a tree with modified tracked files']);
		writeFileSync(join(d, 'a.txt'), 'three\n');
		expect(freshness(d, { revision: now }).reasons).toEqual(['tracked files are modified: a.txt']);
		expect(freshness(d, null).reasons[0]).toBe('no build stamp');
		expect(freshness(join(root, 'not-a-repo'), { revision: now }).reasons.join()).toMatch(/not a git checkout/);
	});
	test('the override, the evidence record and the refusal say what is stale', () => {
		expect(allowStale([ALLOW_FLAG], {})).toBe(true);
		expect(allowStale([], { [ALLOW_ENV]: '1' })).toBe(true);
		expect(allowStale([], {})).toBe(false);
		const f = freshness(join(root, 'not-a-repo'), null);
		const rec = evidenceRecord(f, true);
		expect(rec.evidence).toBe(false);
		expect(rec.freshBuild.allowStaleBuild).toBe(true);
		expect(rec.evidenceNote).toMatch(/^NOT release evidence \(--allow-stale-build\): no build stamp/);
		expect(refusal('parity', f)).toMatch(/^parity: refusing a stale build \(no build stamp; .*\)\. Commit, then run `bun run --bun build`, or pass --allow-stale-build/);
	});
});
