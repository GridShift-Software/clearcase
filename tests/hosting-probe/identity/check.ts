// The identity probe's evidence check (GRS-108). From this directory:
//
//   bun run --bun check:evidence [FILE]   # default ../../../docs/acceptance/hosting/evidence/identity-summary.json
//
// A summary is evidence for the probe's own inputs (this directory and deploy/probes/secrets*, INPUT_PATHS) at the
// revision it ran, not for the whole repository, so a merge that leaves those inputs alone keeps it valid, and any
// change to them makes it stale. The check never replaces the summary's sourceSha with HEAD. It refuses (exit 1) unless:
//   - sourceSha is HEAD or an ancestor of it, and the inputs' tree at HEAD hashes to the summary's digest and to the
//     digest at sourceSha (git ls-tree of INPUT_PATHS, so only committed blobs count);
//   - the summary has exactly the expected shape: every key, type and value, so a missing, null, retyped or extra field
//     fails, every leg is PASS, and evidence is true;
//   - its route table has one row per (app, method, route) of gates.json at HEAD, with that row's gate, exactly the
//     matrix's classes, each check's expectation recomputed here from matrix.ts and met, no leaked marker and no
//     missing one;
//   - its counts recompute from the table, and every Clerk user, invitation and session it created was deleted or ended.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classesOf, expectFor, label, rows, type Row } from './matrix.ts';

export const SCHEMA = 'clearcase.identity-probe/1';
export const INPUT_PATHS = ['tests/hosting-probe/identity', 'deploy/probes/secrets.ts', 'deploy/probes/secrets-child.mjs', 'deploy/probes/secrets-env.mjs'];
export const LEGS = ['integration', 'instances', 'invite-only', 'grants-outside-clerk', 'operator-access', 'revocation', 'expiry-and-recovery', 'restart', 'route-matrix', 'public-entry', 'cleanup', 'credential-scan'] as const;
export type LegName = (typeof LEGS)[number];
export const HOLD = [
	'wrong-client issuer and audience: needs a second client development application (client B) besides Clear-Case-Dev-A; until it exists no token of another client instance can be presented',
	'sibling-subdomain session isolation (moment M3): development instances keep the Clerk client in __clerk_db_jwt, not in first-party cookies on the app domain, so cookie scoping across client subdomains under sandbox.gridshift.co.za can only be shown on production instances there',
	'hosted CSP for clerk-js and the Frontend API (moment M3): the probe serves no clerk-js and sets no CSP',
	"Clerk production instances (moment M3): custom domains under sandbox.gridshift.co.za, the Frontend API CNAMEs and production keys are the release reviewer's provisioning step",
];

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../../..');

function git(args: string[], cwd = ROOT) {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, maxBuffer: 64 << 20 });
	return { code: r.status ?? -1, out: (r.stdout ?? '').trim() };
}

/** sha256 of the committed tree of INPUT_PATHS at `rev` (mode, type, blob id and path of every file). */
export function inputsDigest(rev: string, cwd = ROOT): string {
	const r = git(['ls-tree', '-r', '--full-tree', rev, '--', ...INPUT_PATHS], cwd);
	if (r.code !== 0) return 'sha256:unreadable';
	return `sha256:${createHash('sha256').update(r.out).digest('hex')}`;
}

type Spec = null | boolean | number | string | RegExp | ((v: unknown) => boolean) | Spec[] | { [key: string]: Spec };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const strings = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);

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

type Check = { class: string; expect: string; got: string; leak: string[]; missing: boolean };
type RouteRow = { app: string; method: string; route: string; gate: string; checks: Check[] };

/** The counts a summary states, recomputed from its route table and Clerk ledger. */
export function countsOf(routes: RouteRow[]) {
	const checks = routes.flatMap((r) => (Array.isArray(r?.checks) ? r.checks : []));
	const refused = (c: Check) => /^[45]\d\d /.test(String(c?.expect));
	return { routes: routes.length, checks: checks.length, refused: checks.filter(refused).length, allowed: checks.filter((c) => !refused(c)).length };
}

function routeProblems(table: unknown, expected: Row[]): string[] {
	if (!Array.isArray(table)) return ['routes is not an array'];
	const problems: string[] = [];
	const byKey = new Map<string, RouteRow>();
	for (const r of table as RouteRow[]) {
		const key = `${r?.app} ${r?.method} ${r?.route}`;
		if (byKey.has(key)) problems.push(`routes has ${key} twice`);
		byKey.set(key, r);
	}
	for (const row of expected) {
		const key = `${row.app} ${row.method} ${row.route}`;
		const got = byKey.get(key);
		byKey.delete(key);
		if (!got) {
			problems.push(`routes lacks ${key}`);
			continue;
		}
		const spec: Spec = {
			app: row.app,
			method: row.method,
			route: row.route,
			gate: row.gate,
			checks: classesOf(row).map((cls) => ({ class: cls, expect: label(expectFor(row, cls)), got: label(expectFor(row, cls)), leak: [], missing: false })),
		};
		conform(got, spec, `routes[${key}]`, problems);
	}
	for (const key of byKey.keys()) problems.push(`routes has ${key}, which gates.json does not serve`);
	return problems;
}

/** The one expected shape of a PASS summary, apart from its route table (judged by routeProblems). */
function expectedShape(summary: Record<string, unknown>, ctx: { head: string; digestAt: (rev: string) => string; pins: Record<string, string>; bun: string }): Spec {
	const source = typeof summary.sourceSha === 'string' ? summary.sourceSha : '';
	const node = isObject(summary.hosts) && typeof summary.hosts.node === 'string' ? summary.hosts.node : '';
	const routes = Array.isArray(summary.routes) ? (summary.routes as RouteRow[]) : [];
	const clerk = isObject(summary.clerk) ? (summary.clerk as Record<string, Record<string, unknown>>) : {};
	const digest = ctx.digestAt(ctx.head);
	const instance = (name: string): Spec => ({ name, environment: 'development', signUpMode: 'restricted', mfaRequired: false, secondFactors: 0, captcha: false, tokenSeconds: 60 });
	return {
		schema: SCHEMA,
		sourceSha: SHA,
		inputs: { paths: INPUT_PATHS, digest: (v) => v === digest && v === ctx.digestAt(source) && /^sha256:[0-9a-f]{64}$/.test(String(v)) },
		treeClean: true,
		servedStamp: source,
		startedAt: ISO,
		finishedAt: ISO,
		runDir: /^\.local\/hosting-probe\/identity\/[0-9A-Za-z-]+$/,
		hosts: { bun: ctx.bun, node: /^\d+\.\d+\.\d+$/, build: `Bun ${ctx.bun}`, runner: `Bun ${ctx.bun}`, wrangler: `Node ${node}`, app: `workerd ${ctx.pins.workerd} (native)` },
		pins: { ...ctx.pins },
		artifact: /^sha256:[0-9a-f]{64}$/,
		instances: { client: instance('Clear-Case-Dev-A'), staff: instance('Clear-Case-Dev-B') },
		legs: Object.fromEntries(LEGS.map((n) => [n, { status: 'PASS', asserted: strings }])),
		routes: () => true,
		counts: countsOf(routes),
		clerk: {
			users: { created: posInt, deleted: (v) => v === clerk.users?.created },
			invitations: { created: posInt, deleted: (v) => v === clerk.invitations?.created },
			sessions: { created: posInt, ended: (v) => v === clerk.sessions?.created },
			testingTokens: { created: posInt },
			devBrowsers: { created: posInt },
			apiCalls: { backend: posInt },
		},
		hold: HOLD,
		failure: null,
		evidence: true,
	};
}

export type Context = { head: string; digestAt: (rev: string) => string; isAncestor: (rev: string) => boolean; gatesFile?: string; pins?: Record<string, string>; bun?: string };

/** Every problem that keeps `summary` from being evidence at `head`; empty means it is. */
export function checkSummary(summary: unknown, c: Context): string[] {
	if (!isObject(summary)) return ['summary is not an object'];
	const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
	const ctx = { head: c.head, digestAt: c.digestAt, pins: c.pins ?? pkg.devDependencies, bun: c.bun ?? pkg.packageManager.replace(/^bun@/, '') };
	const problems: string[] = [];
	if (typeof summary.sourceSha !== 'string' || !SHA.test(summary.sourceSha)) problems.push('sourceSha is not a full commit id');
	else if (summary.sourceSha !== c.head && !c.isAncestor(summary.sourceSha)) problems.push(`sourceSha ${summary.sourceSha.slice(0, 12)} is not HEAD or an ancestor of it`);
	conform(summary, expectedShape(summary, ctx), 'summary', problems);
	problems.push(...routeProblems(summary.routes, rows(c.gatesFile)));
	return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	const file = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs/acceptance/hosting/evidence/identity-summary.json'));
	const head = git(['rev-parse', 'HEAD']).out;
	let summary: unknown;
	try {
		summary = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		summary = null;
	}
	const problems = checkSummary(summary, { head, digestAt: (rev) => inputsDigest(rev), isAncestor: (rev) => git(['merge-base', '--is-ancestor', rev, head]).code === 0 });
	for (const p of problems.slice(0, 40)) console.log(`refused: ${p}`);
	const s = summary as { sourceSha?: string } | null;
	console.log(problems.length ? `CHECK FAIL ${path.relative(ROOT, file)}` : `CHECK PASS ${path.relative(ROOT, file)} sourceSha ${s?.sourceSha} inputs ${inputsDigest(head)} at HEAD ${head}`);
	process.exitCode = problems.length ? 1 : 0;
}
