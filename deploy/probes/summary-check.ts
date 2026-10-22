// Checks the committed deployment summary against the checkout (GRS-107). The summary is the probe's own output, written
// at the commit it ran at; a later docs-only commit adds the summary and the page that cites it. The check passes when:
//   - the summary has this schema, evidence true, a clean tree, and all 13 expected PASS legs with their assertions;
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
/** The run's fixed leg set and the number of steps and explicit assertions each leg records. */
export const DEPLOYMENT_LEGS = {
	'P1-discovery': [6, 6],
	'P2a-kit-no-config': [3, 4],
	'P2b-kit-cf-config': [2, 3],
	'P3-build-workerd': [5, 8],
	'P4-local-migrations': [7, 7],
	'migration-failure-rollback': [9, 6],
	'P5-vitest-pool': [2, 2],
	'P6-void-native-d1': [3, 10],
	'P7-cf-dry-run-offline': [1, 4],
	'P8-unforced-destructive': [6, 6],
	'P9-wrong-client': [21, 29],
	'janitor-dry-run': [3, 6],
	'credential-scan': [0, 3],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

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
	let s: unknown;
	try {
		s = JSON.parse(readFileSync(a.summary, 'utf8'));
	} catch (e) {
		return [`${a.summary} cannot be read: ${(e as Error).message}`];
	}
	const problems: string[] = [];
	if (!isRecord(s)) return ['the summary is not an object'];
	if (s.schema !== SUMMARY_SCHEMA) problems.push(`schema is ${JSON.stringify(s.schema)}, not ${SUMMARY_SCHEMA}`);
	if (s.evidence !== true) problems.push('evidence is false: the run did not pass');
	if (s.treeClean !== true) problems.push('treeClean is false: the run did not describe one commit');
	const legs = isRecord(s.legs) ? s.legs : {};
	if (!Object.keys(legs).length) problems.push('the summary holds no legs');
	if (!hasKeys(legs, Object.keys(DEPLOYMENT_LEGS))) problems.push('the summary does not hold exactly the 13 deployment legs');
	for (const [id, shape] of Object.entries(DEPLOYMENT_LEGS)) {
		const leg = legs[id];
		if (!isRecord(leg)) {
			problems.push(`leg ${id} is missing or malformed`);
			continue;
		}
		if (!hasKeys(leg, ['title', 'status', 'steps', 'observed', 'asserted'])) problems.push(`leg ${id} has the wrong fields`);
		if (!nonempty(leg.title)) problems.push(`leg ${id} has no title`);
		if (leg.status !== 'PASS') problems.push(`leg ${id} is ${String(leg.status)}, not PASS`);
		if (!isRecord(leg.observed)) problems.push(`leg ${id} has no observed record`);
		if (!Array.isArray(leg.asserted) || leg.asserted.length !== shape[1] || !leg.asserted.every(nonempty)) problems.push(`leg ${id} must hold ${shape[1]} nonempty assertions`);
		if (!Array.isArray(leg.steps) || leg.steps.length !== shape[0] || !leg.steps.every((step: unknown) =>
			isRecord(step) && hasKeys(step, ['cmd', 'host', 'exit', 'ms', 'network']) && nonempty(step.cmd) && nonempty(step.host)
			&& (step.exit === null || Number.isInteger(step.exit)) && typeof step.ms === 'number' && Number.isFinite(step.ms) && step.ms >= 0
			&& (step.network === 'not recorded (Bun host)' || Array.isArray(step.network) && step.network.every((entry: unknown) => typeof entry === 'string'))
		)) problems.push(`leg ${id} must hold ${shape[0]} well-formed steps`);
	}
	for (const [id, leg] of Object.entries(legs)) if (!Object.hasOwn(DEPLOYMENT_LEGS, id) && isRecord(leg) && leg.status !== 'PASS') problems.push(`leg ${id} is ${String(leg.status)}, not PASS`);
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
