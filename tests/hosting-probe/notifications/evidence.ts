// The check of committed evidence (GRS-111, M2): is this summary this runner's PASS for a revision of this branch, and
// is the Worker it names the Worker in this checkout? Both `probe --check FILE` and `bun run --bun test` (cases.ts)
// call it, so there is one command to document and one place to fix.
//
// Shape alone (summary.ts) cannot tell a summary of this branch from one of a base without the probe, or an artifact
// digest from a zeroed one, or a count of 1 from a count of 1,264. So, beyond the shape for its own sourceSha:
// 1. sourceSha is an ancestor of HEAD;
// 2. nothing under tests/hosting-probe/notifications/ differs from sourceSha, committed or not, tracked or not (so the
//    probe, the Worker and the checks are those of the run);
// 3. a rebuild of src/worker.ts with sourceSha as its stamp has the digest in `artifact` (so the Worker that ran is
//    the Worker in the tree);
// 4. checker.mutationsRefused is the count the walk gives for this summary now (summary.ts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWorker } from './build.ts';
import { checkSummary, isObject, mutationsRefused } from './summary.ts';

const HERE = import.meta.dirname;
const DIR = 'tests/hosting-probe/notifications/';

function git(...args: string[]): { code: number; out: string } {
	const r = spawnSync('git', args, { cwd: HERE, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
	return { code: r.status ?? -1, out: r.stdout.trim() };
}

/** Every reason `summary` is not this runner's PASS for a revision of this checkout; empty means it is. */
export async function evidenceProblems(summary: unknown): Promise<string[]> {
	if (!isObject(summary)) return ['summary is not an object'];
	const sha = summary.sourceSha;
	if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return [`sourceSha is ${JSON.stringify(sha)}, not a full commit SHA`];
	const problems = checkSummary(summary, sha);

	if (git('merge-base', '--is-ancestor', sha, 'HEAD').code !== 0) return [...problems, `sourceSha ${sha.slice(0, 12)} is not an ancestor of HEAD`];
	const changed = [...git('diff', '--name-only', sha, '--', DIR).out.split('\n'), ...git('ls-files', '--others', '--exclude-standard', '--', DIR).out.split('\n')].filter(Boolean);
	if (changed.length) problems.push(`${changed.length} file(s) under ${DIR} differ from sourceSha ${sha.slice(0, 12)}, so the run does not describe this checkout: ${changed.slice(0, 3).join(', ')}`);

	const out = mkdtempSync(path.join(tmpdir(), 'notifications-rebuild-'));
	try {
		const built = await buildWorker(path.join(HERE, 'src/worker.ts'), out, sha);
		const digest = built.success ? `sha256:${createHash('sha256').update(readFileSync(path.join(out, 'worker.js'), 'utf8')).digest('hex')}` : 'no build';
		if (digest !== summary.artifact) problems.push(`a rebuild of src/worker.ts stamped ${sha.slice(0, 12)} is ${digest.slice(0, 19)}…, not artifact ${String(summary.artifact).slice(0, 19)}…`);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}

	if (problems.length === 0 && isObject(summary.checker)) {
		const recomputed = mutationsRefused({ ...summary, checker: { mutationsRefused: 1, accepted: null } }, sha);
		if (recomputed.accepted !== null || recomputed.refused !== summary.checker.mutationsRefused) problems.push(`checker.mutationsRefused is ${String(summary.checker.mutationsRefused)}, but the walk of this summary refuses ${recomputed.refused}${recomputed.accepted ? ` and accepts ${recomputed.accepted}` : ''}`);
	}
	return problems;
}
