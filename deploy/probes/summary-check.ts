// Checks the committed deployment summary against the checkout (GRS-107). The summary is the probe's own output, written
// at the commit it ran at; a later docs-only commit adds the summary and the page that cites it. The check passes when:
//   - the summary has this schema, evidence true, a clean tree, and at least one leg, every one PASS;
//   - its sourceSha is an ancestor of HEAD, never rewritten to HEAD;
//   - it records the git object id of each of the probe's own inputs (PROBE_INPUTS), and those ids are the same at
//     sourceSha and at HEAD, so a merge of other tickets' work changes nothing the summary vouches for;
//   - the page names sourceSha.
//
//   bun deploy/probes/summary-check.ts [--summary FILE] [--doc FILE]     (also: bun probe.ts --check)
//
// Exit 0 PASS, 1 refused.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUMMARY_SCHEMA = 'clearcase.deployment-probe/1';
/** What the probe reads from the repository: nothing outside these decides its result. */
export const PROBE_INPUTS = ['deploy/probes', 'tests/hosting-probe/deployment', 'tests/e2e/pilot/offline.sh'] as const;

/** Every reason the summary at `summary` does not vouch for the checkout at `repo`; empty means it does. */
export function checkSummary(a: { repo: string; summary: string; doc: string }): string[] {
	const git = (...args: string[]) => execFileSync('git', args, { cwd: a.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	const ok = (...args: string[]) => {
		try {
			git(...args);
			return true;
		} catch {
			return false;
		}
	};
	let s: Record<string, unknown>;
	try {
		s = JSON.parse(readFileSync(a.summary, 'utf8'));
	} catch (e) {
		return [`${a.summary} cannot be read: ${(e as Error).message}`];
	}
	const problems: string[] = [];
	if (s.schema !== SUMMARY_SCHEMA) problems.push(`schema is ${JSON.stringify(s.schema)}, not ${SUMMARY_SCHEMA}`);
	if (s.evidence !== true) problems.push('evidence is false: the run did not pass');
	if (s.treeClean !== true) problems.push('treeClean is false: the run did not describe one commit');
	const legs = typeof s.legs === 'object' && s.legs !== null ? Object.entries(s.legs as Record<string, { status?: unknown }>) : [];
	if (!legs.length) problems.push('the summary holds no legs');
	for (const [id, leg] of legs) if (leg?.status !== 'PASS') problems.push(`leg ${id} is ${String(leg?.status)}, not PASS`);
	const sha = s.sourceSha;
	if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return [...problems, `sourceSha is ${sha === undefined ? 'missing' : JSON.stringify(sha)}, not a full commit id`];
	if (!ok('merge-base', '--is-ancestor', sha, 'HEAD')) return [...problems, `sourceSha ${sha} is not an ancestor of HEAD`];
	const recorded = (typeof s.inputs === 'object' && s.inputs !== null ? s.inputs : {}) as Record<string, unknown>;
	for (const input of PROBE_INPUTS) {
		const at = (rev: string) => {
			try {
				return git('rev-parse', `${rev}:${input}`);
			} catch {
				return null;
			}
		};
		if (recorded[input] === undefined || recorded[input] !== at(sha)) problems.push(`${input}: the inputs recorded in the summary are not what ${sha.slice(0, 12)} held`);
		else if (at('HEAD') !== recorded[input]) problems.push(`${input} changed since the run at ${sha.slice(0, 12)}: run the probe again`);
	}
	if (!readFileSync(a.doc, 'utf8').includes(sha)) problems.push(`the page does not name the summary's sourceSha ${sha}`);
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const repo = path.resolve(import.meta.dirname, '../..');
	const args = process.argv.slice(2);
	const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	const summary = path.resolve(arg('--summary') ?? path.join(repo, 'docs/acceptance/hosting/evidence/deployment-summary.json'));
	const doc = path.resolve(arg('--doc') ?? path.join(repo, 'docs/acceptance/hosting/deployment.md'));
	const problems = checkSummary({ repo, summary, doc });
	for (const p of problems) console.error(`refused: ${p}`);
	console.log(`DEPLOYMENT SUMMARY ${problems.length ? 'REFUSED' : 'PASS'}`);
	process.exit(problems.length ? 1 : 0);
}
