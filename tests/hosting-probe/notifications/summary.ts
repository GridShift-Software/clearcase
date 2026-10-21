// The one expected shape of a PASS summary of probe.ts (GRS-111), and the walk that mutates a summary to prove the
// check refuses every change. probe.ts uses both for `--check` and for `checker.mutationsRefused`; cases.ts runs the
// walk over the committed evidence. Same rules as GRS-106's runtime probe: exact key sets at every level, types and
// values, so a missing, null, retyped, extra or changed field fails.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'clearcase.notifications-probe/1';
export const LEGS = [
	'build',
	'binding-config',
	'publication-notice',
	'input-needed-notice',
	'authenticated-link',
	'app-deduplication',
	'wrong-client',
	'content-refused',
	'recipient-missing',
	'interrupted-send',
	'retry-bounded',
	'ambiguous-duplicate',
	'permanent-no-retry',
	'operator-visibility',
	'sender-restriction',
	'binding-missing',
	'no-leak',
] as const;
export type LegName = (typeof LEGS)[number];

/** [commands, asserted] each leg writes; a leg that gains or loses one changes this table, or `evidence` stays false. */
export const LEG_SHAPE: Record<LegName, [number, number]> = {
	build: [1, 4],
	'binding-config': [2, 7],
	'publication-notice': [1, 8],
	'input-needed-notice': [1, 4],
	'authenticated-link': [5, 6],
	'app-deduplication': [2, 4],
	'wrong-client': [4, 4],
	'content-refused': [2, 3],
	'recipient-missing': [2, 3],
	'retry-bounded': [6, 7],
	'ambiguous-duplicate': [5, 7],
	'permanent-no-retry': [2, 3],
	'interrupted-send': [5, 4],
	'operator-visibility': [2, 4],
	'sender-restriction': [4, 5],
	'binding-missing': [4, 5],
	'no-leak': [1, 4],
};

/** The messages the simulated binding must have saved, in this order (env, case, kind); any other count or order fails. */
export const MESSAGES: [string, string, string][] = [
	['default', 'case-a1', 'publication'],
	['default', 'case-a1', 'input-needed'],
	['faults', 'case-a8', 'input-needed'],
	['faults', 'case-a3', 'publication'],
	['faults', 'case-a3', 'publication'],
	['faults', 'case-a4', 'publication'],
];
/** What the app saw for each saved message, measured: its messageId came back in a response, or the attempt ended without one. */
export const APP_SAW = ['accepted', 'accepted', 'accepted', 'not seen: the attempt ended ambiguous', 'accepted', 'accepted'];

export const HOLD = [
	'provider acceptance against delivery and inbox arrival on real Email Sending: M3, Workers Paid',
	'SPF, DKIM and DMARC on a sending subdomain under sandbox.gridshift.co.za with its own _dmarc record: M3',
	'allowed_sender_addresses enforced by the real binding (the simulator enforces it; see sender-restriction): M3',
	'the Paid qualifier and whether Workers Free can send (the pricing page contradicts itself): M3',
	'real provider error responses: the E_* failures here come from the faults double',
];
export const BOUNDARIES = {
	runtime: 'real: native workerd under wrangler dev --local',
	d1: 'real local: Miniflare D1',
	r2: 'real local: Miniflare R2',
	email: 'simulated: the local send_email binding saves each message and sends nothing',
	providerFailures: 'double: FAULT_PLAN in the faults environment',
	identity: 'double: the x-probe-identity header stands in for a Clerk session',
};
/** The keys of the environment every child gets (GRS-106's allowlist), sorted. */
export const ENV_KEYS = ['CI', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'HOME', 'PATH', 'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_SEND_METRICS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];

export const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
export const BUN = pkg.packageManager.replace(/^bun@/, '');

/** A literal is deep-equal; a RegExp matches a string; a function is a predicate; an array has exactly its length; an object exactly its keys. */
type Spec = null | boolean | string | RegExp | ((v: unknown) => boolean) | Spec[] | { [key: string]: Spec };
const NONEMPTY = (v: unknown) => typeof v === 'string' && v.length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function expectedShape(sha: string, summary: Record<string, unknown>): Spec {
	const node = isObject(summary.hosts) && typeof summary.hosts.node === 'string' ? summary.hosts.node : '';
	const workerd = pkg.devDependencies.workerd!;
	return {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: true,
		servedRevision: sha,
		startedAt: ISO,
		finishedAt: ISO,
		runDir: /^\.local\/hosting-probe\/notifications\/[0-9A-Za-z-]+$/,
		hosts: { bun: BUN, node: /^\d+\.\d+\.\d+$/, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node}`, app: `workerd ${workerd} (native)` },
		pins: { ...pkg.devDependencies },
		artifact: /^sha256:[0-9a-f]{64}$/,
		isolation: { network: /^own network namespace: interfaces \[lo\], 0 IPv4 routes, 0 IPv6 routes; /, env: ENV_KEYS },
		boundaries: { ...BOUNDARIES },
		legs: Object.fromEntries(LEGS.map((name) => [name, { status: 'PASS', commands: Array.from({ length: LEG_SHAPE[name][0] }, () => NONEMPTY), asserted: Array.from({ length: LEG_SHAPE[name][1] }, () => NONEMPTY) }])),
		messages: MESSAGES.map(([env, caseId, kind], i) => ({ env, caseId, kind, text: /^sha256:[0-9a-f]{64}$/, contentCheck: 'PASS', appSaw: APP_SAW[i]!, providerAcceptance: 'simulated: saved by the local binding', delivery: 'HOLD: M3', inboxArrival: 'HOLD: M3' })),
		hold: HOLD,
		failure: null,
		evidence: true,
		checker: { mutationsRefused: (v) => Number.isInteger(v) && (v as number) > 0, accepted: null },
	};
}

function conform(value: unknown, spec: Spec, at: string, problems: string[]): void {
	const seen = JSON.stringify(value) ?? 'missing';
	const got = seen.length > 60 ? `${seen.slice(0, 60)}…` : seen;
	if (spec instanceof RegExp) {
		if (typeof value !== 'string' || !spec.test(value)) problems.push(`${at} is ${got}, not ${spec}`);
	} else if (typeof spec === 'function') {
		if (!spec(value)) problems.push(`${at} is ${got}, which the runner never writes`);
	} else if (Array.isArray(spec)) {
		if (!Array.isArray(value) || value.length !== spec.length) problems.push(`${at} is ${got}, not an array of ${spec.length}`);
		else spec.forEach((s, i) => conform(value[i], s, `${at}[${i}]`, problems));
	} else if (isObject(spec)) {
		if (!isObject(value)) return void problems.push(`${at} is ${got}, not an object`);
		for (const k of Object.keys(value)) if (!(k in spec)) problems.push(`${at}.${k} is not a field of the summary`);
		for (const [k, s] of Object.entries(spec)) if (k in value) conform(value[k], s, `${at}.${k}`, problems);
		else problems.push(`${at}.${k} is missing`);
	} else if (value !== spec) problems.push(`${at} is ${got}, not ${JSON.stringify(spec)}`);
}

/** Every problem that keeps `summary` from being this runner's evidence for `sha`; empty means it is. */
export function checkSummary(summary: unknown, sha: string): string[] {
	if (!isObject(summary)) return ['summary is not an object'];
	const problems: string[] = [];
	conform(summary, expectedShape(sha, summary), 'summary', problems);
	return problems;
}

/** Every leaf and container of the summary deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown key added to each object: the count refused, or the first accepted. */
export function mutationsRefused(summary: Record<string, unknown>, sha: string): { refused: number; accepted: string | null } {
	let refused = 0;
	let accepted: string | null = null;
	const attempt = (label: string, edit: (copy: Record<string, unknown>) => void) => {
		const copy = structuredClone(summary);
		edit(copy);
		if (accepted !== null || JSON.stringify(copy) === JSON.stringify(summary)) return; // not a mutation
		if (checkSummary(copy, sha).length === 0) accepted = label;
		else refused++;
	};
	const walk = (value: unknown, p: (string | number)[]) => {
		const label = p.join('.');
		const holder = (copy: Record<string, unknown>) => p.slice(0, -1).reduce<any>((o, k) => o[k], copy);
		if (p.length) {
			const key = p.at(-1)!;
			attempt(`${label} deleted`, (c) => (Array.isArray(holder(c)) ? holder(c).splice(key as number, 1) : delete holder(c)[key]));
			attempt(`${label} null`, (c) => (holder(c)[key] = null));
			attempt(`${label} retyped`, (c) => (holder(c)[key] = typeof value === 'string' ? 1 : typeof value === 'object' && value !== null ? 'x' : String(value)));
			if (typeof value === 'string') attempt(`${label} emptied`, (c) => (holder(c)[key] = ''));
			if (typeof value === 'boolean') attempt(`${label} flipped`, (c) => (holder(c)[key] = !value));
			if (typeof value === 'number') attempt(`${label} zeroed`, (c) => (holder(c)[key] = 0));
		}
		if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...p, i]));
		else if (isObject(value)) {
			attempt(`${label || '<root>'} + unknown key`, (c) => (p.reduce<any>((o, k) => o[k], c).__unknown = 1));
			for (const [k, v] of Object.entries(value)) walk(v, [...p, k]);
		}
	};
	walk(summary, []);
	return { refused, accepted };
}
