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
import { isDeepStrictEqual } from 'node:util';
import { RUN_NAME } from './cloud-run.ts';

export const SUMMARY_SCHEMA = 'clearcase.deployment-probe/1';
/** What the probe reads from the repository: nothing outside these decides its result. */
export const PROBE_INPUTS = ['deploy/probes', 'tests/hosting-probe/deployment', 'tests/e2e/pilot/offline.sh'] as const;
export const DEPLOYMENT_HOLD = [
	'P10 (moment M1, Workers Free): a real prebuilt upload with an upload-only token, enforced token grants and denied actions, a Void deploy with pending D1 migrations behind a time-travel bookmark, a Worker rollback, and teardown of cc-* resources through the run manifest',
	"the janitor's real sweep of the account's cc-* resources (M1)",
	'actual token breadth on the real API: no resource-scoped Worker or D1 token is claimed',
] as const;
export const PROBE_ENV_KEYS = [
	'BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'CI', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_DEPENDENCIES_INSTRUMENTATION',
	'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'DO_NOT_TRACK', 'HOME', 'PATH',
	'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_SEND_METRICS',
	'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
] as const;
export const PROBE_ENVIRONMENT = {
	BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', CI: '1', CLOUDFLARE_CF_FETCH_ENABLED: 'false',
	CLOUDFLARE_DEPENDENCIES_INSTRUMENTATION: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
	CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', DO_NOT_TRACK: '1', HOME: '<run>/home',
	PATH: '<node-dir>:<bun-dir>:/usr/bin:/bin', WRANGLER_HIDE_BANNER: 'true',
	WRANGLER_LOG_PATH: '<run>/logs/wrangler', WRANGLER_SEND_ERROR_REPORTS: 'false',
	WRANGLER_SEND_METRICS: 'false', XDG_CACHE_HOME: '<run>/home/.cache', XDG_CONFIG_HOME: '<run>/home/.config',
} as const;
type Transcript = Record<string, { title: string; steps: { host: string; cmd: string; exit: number | null; network: string[] | string }[]; asserted: string[] }>;
/** Reviewed transcript that the runner and committed summary must both match. Dynamic values are bound below. */
export const DEPLOYMENT_TRANSCRIPT: Transcript = JSON.parse(readFileSync(path.join(import.meta.dirname, 'transcript.json'), 'utf8'));
/** Fixed PASS shape: [steps, assertions, observed fields] for each of the runner's 13 legs. */
export const DEPLOYMENT_LEGS = {
	'P1-discovery': [6, 6, ['cfEngines', 'nodeSatisfiesCfEngines', 'bun', 'searchMatches']],
	'P2a-kit-no-config': [3, 4, ['initDryRun', 'refusal', 'fallback']],
	'P2b-kit-cf-config': [2, 3, ['buildExit', 'buildOutputWritten', 'error', 'deployDryRunExit', 'deployDryRunCompleted']],
	'P3-build-workerd': [5, 8, ['artifact', 'health', 'harnessUnderBun']],
	'P4-local-migrations': [7, 7, ['cfQueryLocal', 'cfRows', 'wranglerRows', 'wranglerReadsCfState', 'wranglerDevOnCfState']],
	'migration-failure-rollback': [9, 6, ['before', 'afterFailure', 'firstStatementOf0003Kept', 'afterRollback', 'rollback']],
	'P5-vitest-pool': [2, 2, ['node', 'bun']],
	'P6-void-native-d1': [3, 10, ['info', 'build', 'generatedConfigBindsD1', 'bundleModules', 'configEvaluations', 'deployOffline', 'automaticMigrations', 'canaryInVoidOutputs', 'voidScanFiles']],
	'P7-cf-dry-run-offline': [1, 4, ['writes', 'writeFree']],
	'P8-unforced-destructive': [6, 6, ['cf d1 delete, no token', 'cf d1 delete', 'cf workers delete', 'cf d1 delete --local', 'wrangler d1 delete']],
	'P9-wrong-client': [21, 29, ['account', 'own', 'refusals', 'dryRunAlone', 'prebuilt']],
	'janitor-dry-run': [3, 6, ['plan', 'withoutManifests', 'runName']],
	'credential-scan': [0, 3, ['roots', 'files', 'hits', 'control']],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const packageFile = path.resolve(import.meta.dirname, '../../tests/hosting-probe/deployment/package.json');
const probePackage: unknown = JSON.parse(readFileSync(packageFile, 'utf8'));
if (!isRecord(probePackage) || !isRecord(probePackage.devDependencies) || !nonempty(probePackage.packageManager)) throw new Error(`${packageFile} lacks pinned probe dependencies`);
export const DEPLOYMENT_PINS = probePackage.devDependencies;
export const DEPLOYMENT_BUN = probePackage.packageManager.replace(/^bun@/, '');

export function transcriptProblems(a: { legs: Record<string, unknown>; sourceSha: unknown; startedAt: unknown }): string[] {
	const problems: string[] = [];
	const observed = (id: string) => isRecord(a.legs[id]) && isRecord(a.legs[id].observed) ? a.legs[id].observed : {};
	const artifact = observed('P3-build-workerd').artifact;
	const voidFiles = observed('P6-void-native-d1').voidScanFiles;
	const files = observed('credential-scan').files;
	const runName = observed('janitor-dry-run').runName;
	if (typeof artifact !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(artifact)) problems.push('P3-build-workerd artifact digest is malformed');
	if (!Number.isInteger(voidFiles) || typeof voidFiles !== 'number' || voidFiles < 1) problems.push('P6-void-native-d1 scan file count is malformed');
	if (!Number.isInteger(files) || typeof files !== 'number' || files < 1) problems.push('credential-scan file count is malformed');
	if (typeof runName !== 'string' || !RUN_NAME.test(runName) || typeof a.sourceSha !== 'string' || !runName.startsWith(`cc-107-w1-${a.sourceSha.slice(0, 7)}-`)) problems.push('janitor-dry-run run name is malformed');
	const values: Record<string, string> = {
		'<artifact>': typeof artifact === 'string' ? artifact : '',
		'<sourceSha>': typeof a.sourceSha === 'string' ? a.sourceSha : '',
		'<startedAt>': typeof a.startedAt === 'string' ? a.startedAt : '',
		'<voidFiles>': typeof voidFiles === 'number' ? String(voidFiles) : '',
		'<files>': typeof files === 'number' ? String(files) : '',
		'<runName>': typeof runName === 'string' ? runName : '',
	};
	const expand = (value: string) => Object.entries(values).reduce((text, [key, replacement]) => text.replaceAll(key, replacement), value);
	for (const [id, expected] of Object.entries(DEPLOYMENT_TRANSCRIPT)) {
		const leg = a.legs[id];
		if (!isRecord(leg)) continue;
		if (leg.title !== expected.title) problems.push(`leg ${id} title does not match the probe definition`);
		const steps = Array.isArray(leg.steps) ? leg.steps.map((step: unknown) => isRecord(step) ? { host: step.host, cmd: step.cmd, exit: step.exit, network: step.network } : step) : leg.steps;
		if (!isDeepStrictEqual(steps, expected.steps.map((step) => ({ host: step.host, cmd: expand(step.cmd), exit: step.exit, network: step.network })))) problems.push(`leg ${id} steps do not match the probe definition`);
		if (!isDeepStrictEqual(leg.asserted, expected.asserted.map(expand))) problems.push(`leg ${id} assertions do not match the probe definition`);
	}
	return problems;
}

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
	if (!hasKeys(s, ['schema', 'sourceSha', 'inputs', 'treeClean', 'startedAt', 'finishedAt', 'runDir', 'hosts', 'pins', 'isolation', 'legs', 'hold', 'evidence'])) problems.push('the summary has the wrong fields');
	if (!nonempty(s.startedAt) || !ISO.test(s.startedAt) || !Number.isFinite(Date.parse(s.startedAt))) problems.push('startedAt is not an ISO time');
	if (!nonempty(s.finishedAt) || !ISO.test(s.finishedAt) || !Number.isFinite(Date.parse(s.finishedAt)) || typeof s.startedAt === 'string' && Date.parse(s.finishedAt) < Date.parse(s.startedAt)) problems.push('finishedAt is not an ISO time after startedAt');
	if (typeof s.runDir !== 'string' || !/^\.local\/hosting-probe\/deployment\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(s.runDir)) problems.push('runDir is not a deployment probe run directory');
	if (!isDeepStrictEqual(s.pins, DEPLOYMENT_PINS)) problems.push('pins do not match the deployment probe package');
	const hosts = isRecord(s.hosts) ? s.hosts : {};
	if (!hasKeys(hosts, ['bun', 'node', 'runner', 'appBuild', 'tools', 'app']) || hosts.bun !== DEPLOYMENT_BUN || !nonempty(hosts.node)
		|| hosts.runner !== `Bun ${DEPLOYMENT_BUN}` || hosts.appBuild !== `Bun ${DEPLOYMENT_BUN}`
		|| hosts.tools !== `Node ${hosts.node} (cf, Wrangler, Void, Vitest)` || hosts.app !== `workerd ${DEPLOYMENT_PINS.workerd} (native, local)`)
		problems.push('hosts do not match the probe runtimes and pins');
	const isolation = isRecord(s.isolation) ? s.isolation : {};
	if (!hasKeys(isolation, ['network', 'env']) || isolation.network !== 'own network namespace: interfaces [lo], 0 IPv4 routes, 0 IPv6 routes; host resolver sockets hidden'
		|| !isDeepStrictEqual(isolation.env, PROBE_ENVIRONMENT)) problems.push('isolation does not describe the offline probe environment');
	if (!isDeepStrictEqual(s.hold, DEPLOYMENT_HOLD)) problems.push('hold is not the deployment cloud-leg boundary');
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
		if (!isRecord(leg.observed) || !hasKeys(leg.observed, shape[2])) problems.push(`leg ${id} has the wrong observed fields`);
		if (!Array.isArray(leg.asserted) || leg.asserted.length !== shape[1] || !leg.asserted.every(nonempty)) problems.push(`leg ${id} must hold ${shape[1]} nonempty assertions`);
		if (!Array.isArray(leg.steps) || leg.steps.length !== shape[0] || !leg.steps.every((step: unknown) =>
			isRecord(step) && hasKeys(step, ['cmd', 'host', 'exit', 'ms', 'network']) && nonempty(step.cmd) && nonempty(step.host)
			&& (step.exit === null || Number.isInteger(step.exit)) && typeof step.ms === 'number' && Number.isFinite(step.ms) && step.ms >= 0
			&& (step.network === 'not recorded (Bun host)' || Array.isArray(step.network) && step.network.every((entry: unknown) => typeof entry === 'string'))
		)) problems.push(`leg ${id} must hold ${shape[0]} well-formed steps`);
	}
	for (const [id, leg] of Object.entries(legs)) if (!Object.hasOwn(DEPLOYMENT_LEGS, id) && isRecord(leg) && leg.status !== 'PASS') problems.push(`leg ${id} is ${String(leg.status)}, not PASS`);
	problems.push(...transcriptProblems({ legs, sourceSha: s.sourceSha, startedAt: s.startedAt }));
	const sha = s.sourceSha;
	if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return [...problems, `sourceSha is ${sha === undefined ? 'missing' : JSON.stringify(sha)}, not a full commit id`];
	if (!ok('merge-base', '--is-ancestor', sha, 'HEAD')) return [...problems, `sourceSha ${sha} is not an ancestor of HEAD`];
	const recorded = isRecord(s.inputs) ? s.inputs : {};
	if (!hasKeys(recorded, PROBE_INPUTS)) problems.push('inputs must name exactly the deployment probe inputs');
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
