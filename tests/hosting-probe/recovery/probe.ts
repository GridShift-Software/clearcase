// The local workerd legs of the recovery proof (GRS-110). From this directory, after the storage probe's install:
//
//   (cd ../storage && bun install --frozen-lockfile)   # once, online: Wrangler, workerd and Miniflare at GRS-109's pins
//   bun run --bun probe [--out FILE]
//   bun run --bun probe --check FILE                  # shape; sourceSha an ancestor of HEAD and the git object id of each input as at sourceSha
//   bun run --bun test:check                          # the committed summary passes; a made-up sourceSha and every mutation are refused
//
// The first form builds this directory's Worker (GRS-109's storage Worker behind the recovery and deletion routes) with
// Bun, provisions local D1 databases and R2 buckets with Wrangler's CLI, serves each deployment on native workerd through
// `wrangler dev --local` (Node hosts Wrangler only) and runs each leg against it. It runs inside tests/e2e/pilot/offline.sh,
// so no Cloudflare account, login or request is possible, and gives every child an explicit environment allowlist. It
// refuses (exit 2) a dirty tree, Bun other than packageManager's, an installed package that is not the storage probe's pin,
// or a Node that is really Bun. It writes the summary (default .local/hosting-probe/recovery/summary.json) and exits 0 only
// when `evidence` is true: every leg PASS, HEAD and the tree unchanged, and every mutation of the summary refused.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DESCRIPTOR_SIZE, type Entry, crc32, descriptor, localHeader, trailer } from '../storage/src/zip.ts';

const HERE = import.meta.dirname;
const STORAGE = path.join(HERE, '../storage');
const SCHEMA = 'clearcase.recovery-probe/1';
const LEGS = ['build', 'provision', 'crossed-recovery', 'seed', 'rollback', 'copies', 'deletion-flow', 'deletion-reapply', 'restore-from-copy', 'retention', 'restore-leftovers', 'ledger-guards', 'warm-isolate'] as const;
type LegName = (typeof LEGS)[number];
type Measure = Record<string, number | string | boolean>;
type Leg = { status: 'PASS' | 'FAIL' | 'NOT RUN'; commands: string[]; asserted: string[]; measured: Measure; failure?: string };
const PORT = 18810;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 24 * 60 * 60 * 1000;
/** The cloud legs: each needs moment M2 (Workers Paid plus R2, EU jurisdiction) and Dian's unpin. */
const HOLD = [
	'one-hour RPO for Notes and case edits through D1 Time Travel: Time Travel is remote-only (M2)',
	'30-day rotation on the platform: Time Travel keeps 30 days only on Workers Paid, and an R2 lifecycle rule ages objects only remotely (M2)',
	'elapsed restore observation against the four-staffed-hour aim, on real Workers, D1 and R2 (M2)',
];

class Refusal extends Error {}

const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string };
const tools = JSON.parse(readFileSync(path.join(STORAGE, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
const BUN = pkg.packageManager.replace(/^bun@/, '');

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HERE, env: opts.env ?? {}, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`, stdout: r.stdout ?? '' };
}
function git(...args: string[]): string {
	const r = run('git', args, { env: { PATH: '/usr/bin:/bin' } });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
}
const repo = () => git('rev-parse', '--show-toplevel');
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ----- the summary's one exact shape -----

/** [commands, asserted] each leg writes; a leg that gains or loses one changes this table, or `evidence` stays false. */
const LEG_SHAPE: Record<LegName, [number, number]> = {
	build: [1, 3],
	provision: [4, 3],
	'crossed-recovery': [4, 5],
	seed: [6, 5],
	rollback: [5, 12],
	copies: [5, 7],
	'deletion-flow': [6, 17],
	'deletion-reapply': [6, 9],
	'restore-from-copy': [7, 15],
	retention: [5, 13],
	'restore-leftovers': [5, 9],
	'ledger-guards': [4, 4],
	'warm-isolate': [5, 6],
};
type Spec = null | boolean | number | string | RegExp | ((v: unknown) => boolean) | Spec[] | { [key: string]: Spec };
const NONEMPTY = (v: unknown) => typeof v === 'string' && v.length > 0;
const POSITIVE = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const MS = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0; // a local wall time; zero would hide a zeroed field
const RETRIES = (v: unknown) => isObject(v) && Object.keys(v).sort().join() === 'count,requests' && Array.isArray(v.requests) && v.requests.every(NONEMPTY) && v.count === v.requests.length;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What each leg measures, and what each value must be. Counts the legs fix are literals; timings are local only. */
const MEASURES: Record<LegName, Record<string, Spec>> = {
	build: { workerBytes: POSITIVE },
	provision: { deployments: 3, schemaStatements: POSITIVE },
	'crossed-recovery': { refusedRequests: 4 },
	seed: { cases: 2, originals: 3, sharedOriginals: 1, workRows: 5 },
	rollback: { activations: 4, workRowsKept: 3, staleRefused: 1 },
	copies: { copies: 4, corruptedCopiesRefused: 1, rowsAfterCopy: 2 },
	'deletion-flow': { refusedSteps: 12, routesGone: 9, erasedObjects: POSITIVE, residueRows: 0 },
	'deletion-reapply': { restoresRefused: 5, rollbackLostRows: 1, reappliedAfterRollback: true },
	'restore-from-copy': { restoredOriginals: 2, lostRowsAfterCopy: 2, stageMs: MS, restoreMs: MS, checksMs: MS, totalMs: MS },
	retention: { rotations: 6, copiesRemoved: 4, copiesKept: 0, bundleVersionsKept: 1, packetsAged: 1 },
	'restore-leftovers': { stepped: 6, erasedByLedger: 3, agedOut: 3, kept: 3, residueRows: 0 },
	'ledger-guards': { refusedRequests: 3 },
	'warm-isolate': { routesGone: 9, repeatedRemovals: 1, residueRows: 0 },
};
const ENV_KEYS = ['CI', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'HOME', 'PATH', 'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_SEND_METRICS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];

function expectedShape(sha: string, summary: Record<string, unknown>): Spec {
	const node = isObject(summary.hosts) && typeof summary.hosts.node === 'string' ? summary.hosts.node : '';
	const workerd = tools.devDependencies.workerd!;
	return {
		schema: SCHEMA,
		sourceSha: sha,
		inputs: Object.fromEntries(PROBE_INPUTS.map((input) => [input, /^[0-9a-f]{40}$/])),
		treeClean: true,
		startedAt: ISO,
		finishedAt: ISO,
		runDir: /^\.local\/hosting-probe\/recovery\/[0-9A-Za-z-]+$/,
		hosts: { bun: BUN, node: /^\d+\.\d+\.\d+$/, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node}`, app: `workerd ${workerd} (native)` },
		pins: { ...tools.devDependencies },
		artifact: /^sha256:[0-9a-f]{64}$/,
		isolation: { network: /^own network namespace: interfaces \[lo\], 0 IPv4 routes, 0 IPv6 routes; /, env: ENV_KEYS },
		legs: Object.fromEntries(LEGS.map((name) => [name, { status: 'PASS', commands: Array.from({ length: LEG_SHAPE[name][0] }, () => NONEMPTY), asserted: Array.from({ length: LEG_SHAPE[name][1] }, () => NONEMPTY), measured: MEASURES[name] }])),
		hold: HOLD,
		devProxyRetries: RETRIES,
		failure: null,
		evidence: true,
		checker: { mutationsRefused: POSITIVE, accepted: null },
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

export function checkSummary(summary: unknown, sha: string): string[] {
	if (!isObject(summary)) return ['summary is not an object'];
	const problems: string[] = [];
	conform(summary, expectedShape(sha, summary), 'summary', problems);
	return problems;
}

/** Every leaf and container of the summary deleted, nulled, retyped, emptied, flipped, zeroed or negated, and an unknown key added to each object. */
export function mutationsRefused(summary: Record<string, unknown>, sha: string): { refused: number; accepted: string | null } {
	let refused = 0;
	let accepted: string | null = null;
	const attempt = (label: string, edit: (copy: Record<string, unknown>) => void) => {
		const copy = structuredClone(summary);
		edit(copy);
		if (accepted !== null || JSON.stringify(copy) === JSON.stringify(summary)) return;
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
			if (typeof value === 'number' && value !== 0) attempt(`${label} zeroed`, (c) => (holder(c)[key] = 0));
			if (typeof value === 'number') attempt(`${label} negated`, (c) => (holder(c)[key] = -1 - (value as number)));
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

// ----- host checks, processes and requests -----

/** The first `node` on PATH that is really Node, not Bun's `bun run --bun` stand-in; Wrangler hangs under Bun. */
function realNode(): { path: string; version: string } {
	for (const dir of (process.env.PATH ?? '').split(':')) {
		const candidate = path.join(dir, 'node');
		try {
			accessSync(candidate, constants.X_OK);
		} catch {
			continue;
		}
		const r = run(candidate, ['-p', 'JSON.stringify([process.versions.node, process.versions.bun ?? null])']);
		if (r.code !== 0) continue;
		const [node, bun] = JSON.parse(r.stdout) as [string, string | null];
		if (bun === null) return { path: candidate, version: node };
	}
	throw new Refusal('no real Node on PATH (Wrangler needs Node >= 22; `node` under `bun run --bun` is Bun)');
}

function checkInstalled(): Record<string, string> {
	const wrong: string[] = [];
	for (const [name, pin] of Object.entries(tools.devDependencies)) {
		const file = path.join(STORAGE, 'node_modules', name, 'package.json');
		const installed = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version : 'missing';
		if (installed !== pin) wrong.push(`${name} ${installed} (pin ${pin})`);
	}
	if (wrong.length) throw new Refusal(`the storage probe's installed packages differ from its pins: ${wrong.join(', ')}; run bun install --frozen-lockfile in ../storage`);
	return { ...tools.devDependencies };
}

function checkOffline(): string {
	const ip = (...a: string[]) => JSON.parse(run('ip', a, { env: { PATH: '/usr/bin:/bin' } }).stdout) as unknown[];
	const links = (ip('-j', 'addr') as { ifname: string }[]).map((l) => l.ifname);
	const routes4 = ip('-4', '-j', 'route');
	const routes6 = ip('-6', '-j', 'route');
	if (links.join() !== 'lo' || routes4.length || routes6.length) throw new Refusal(`not offline: interfaces ${links.join(',')}, ${routes4.length} IPv4 and ${routes6.length} IPv6 routes`);
	return 'own network namespace: interfaces [lo], 0 IPv4 routes, 0 IPv6 routes; host resolver sockets hidden';
}

type Proc = { pid: number; ppid: number; pgrp: number; exe: string };
function processes(): Map<number, Proc> {
	const out = new Map<number, Proc>();
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			let exe = '?';
			try {
				exe = path.basename(readlinkSync(`/proc/${name}/exe`));
			} catch {}
			out.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]), exe });
		} catch {}
	}
	return out;
}
function descendants(root: number): Proc[] {
	const every = processes();
	const ids = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of every.values()) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
	}
	return [...ids].map((id) => every.get(id)).filter((p): p is Proc => p !== undefined);
}

type Server = { child: ChildProcess; tree: Proc[]; label: string };
const live = new Set<Server>();
async function stopServer(server: Server): Promise<void> {
	const { child } = server;
	const pgid = child.pid!;
	const left = () => [...processes().values()].filter((p) => p.pgrp === pgid || server.tree.some((t) => t.pid === p.pid && t.exe === p.exe));
	const gone = () => (child.exitCode !== null || child.signalCode !== null) && left().length === 0;
	for (const [signal, ms] of [['SIGINT', 12_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (gone()) break;
		try {
			process.kill(-pgid, signal);
		} catch {}
		for (const until = Date.now() + ms; Date.now() < until && !gone(); ) await new Promise((r) => setTimeout(r, 100));
	}
	live.delete(server);
	const survivors = left();
	if (survivors.length) throw new Error(`${server.label}: processes survived the stop: ${survivors.map((p) => `${p.pid} ${p.exe}`).join(', ')}`);
}

type Res = { status: number; type: string; headers: Headers; bytes: Uint8Array; text: string; json: () => any };
const DROPPED = 'Error: Network connection lost.';
/** Requests Wrangler's dev proxy dropped before they reached the Worker (GRS-109's storage page); each was retried. */
const proxyRetries: string[] = [];
let currentLeg = 'setup';
async function http(pathname: string, init: RequestInit & { timeout?: number } = {}): Promise<Res> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(BASE + pathname, { redirect: 'manual', ...init, signal: AbortSignal.timeout(init.timeout ?? 120_000) });
		const bytes = new Uint8Array(await res.arrayBuffer());
		const type = res.headers.get('content-type') ?? '';
		const text = new TextDecoder().decode(bytes.subarray(0, 4096));
		if (res.status === 500 && !type.startsWith('application/json') && text.startsWith(DROPPED) && attempt <= 2) {
			proxyRetries.push(`${currentLeg}: ${init.method ?? 'GET'} ${pathname.replace(/[0-9a-f]{64}/g, '<sha256>').replace(/[0-9a-f-]{36}/g, '<id>')} (attempt ${attempt + 1})`);
			await new Promise((r) => setTimeout(r, 250));
			continue;
		}
		return { status: res.status, type, headers: res.headers, bytes, text, json: () => JSON.parse(new TextDecoder().decode(bytes)) };
	}
}
const post = (p: string, b: unknown, timeout?: number) => http(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), timeout });
const code = (r: Res, status: number, c: string) => r.status === status && r.type.startsWith('application/json') && r.json().code === c;
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

// ----- the synthetic cases -----

const enc = new TextEncoder();
const synthetic = (label: string, n: number) => enc.encode(`SYNTHETIC ONLY: ${label}\n`.repeat(n));
const versionOf = (label: string) => `sha256:${sha256(`recovery probe version ${label}`)}`;
type Item = { path: string; kind: string; bytes: Uint8Array };
/** A case backup (GRS-109's format) holding only what a restore step copies: the manifest first, then each entry with its CRC-32. */
const backupZip = (caseId: string, resultsVersion: string, items: Item[]) => {
	const manifest = { format: 'clearcase.case-backup/1', client: 'client-a', caseId, resultsVersion, entries: items.map((i) => ({ path: i.path, sha256: sha256(i.bytes), size: i.bytes.length, kind: i.kind })) };
	const parts: Uint8Array[] = [];
	const entries: Entry[] = [];
	let at = 0;
	for (const i of [{ path: 'manifest.json', kind: 'manifest', bytes: enc.encode(JSON.stringify(manifest)) }, ...items]) {
		const header = localHeader(i.path);
		entries.push({ path: i.path, crc: crc32(i.bytes), size: i.bytes.length, offset: at });
		parts.push(header, i.bytes, descriptor(crc32(i.bytes), i.bytes.length));
		at += header.length + i.bytes.length + DESCRIPTOR_SIZE;
	}
	parts.push(trailer(entries, at));
	return Buffer.concat(parts);
};
type Original = { assetId: string; bytes: Uint8Array; sha: string; filename: string };
const original = (assetId: string, label: string, n: number): Original => {
	const bytes = synthetic(label, n);
	return { assetId, bytes, sha: sha256(bytes), filename: `${assetId}.pdf` };
};
const A1 = 'case-recovery-a1';
const A2 = 'case-recovery-a2';
const oA1 = original('a1-letter', 'recovery probe A1 letter', 300);
const oShared = original('shared-statement', 'recovery probe statement shared by A1 and A2', 400);
const oA2 = original('a2-invoice', 'recovery probe A2 invoice', 250);
const V1 = versionOf('A1 v1');
const V2 = versionOf('A1 v2');
const VB = versionOf('A2 v1');

async function main(out: string, keepState: boolean, allowDirty: boolean): Promise<number> {
	const root = repo();
	const sha = head();
	if (dirty() && !allowDirty) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
	rmSync(out, { force: true });
	const runDir = path.join(root, '.local', 'hosting-probe', 'recovery', new Date().toISOString().replace(/[:.]/g, '-'));
	const logs = path.join(runDir, 'logs');
	const persist = path.join(runDir, 'persist');
	const scratch = path.join(runDir, 'scratch');
	for (const d of ['home/.config', 'cache', 'logs/wrangler', 'persist', 'scratch']) mkdirSync(path.join(runDir, d), { recursive: true });
	const env: Record<string, string> = {
		PATH: `${path.dirname(node.path)}:/usr/bin:/bin`,
		HOME: path.join(runDir, 'home'),
		XDG_CONFIG_HOME: path.join(runDir, 'home/.config'),
		XDG_CACHE_HOME: path.join(runDir, 'cache'),
		CI: '1',
		WRANGLER_SEND_METRICS: 'false',
		WRANGLER_SEND_ERROR_REPORTS: 'false',
		WRANGLER_HIDE_BANNER: 'true',
		WRANGLER_LOG_PATH: path.join(runDir, 'logs/wrangler'),
		CLOUDFLARE_CF_FETCH_ENABLED: 'false',
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
		CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
	};
	const WRANGLER = path.join(STORAGE, 'node_modules/wrangler/bin/wrangler.js');
	let cli = 0;
	const wrangler = (...args: string[]) => {
		const r = run(node.path, [WRANGLER, ...args, '--persist-to', persist], { env });
		writeFileSync(path.join(logs, `cli-${String(++cli).padStart(3, '0')}-${args.slice(0, 3).join('-').replace(/[^A-Za-z0-9-]/g, '_')}.log`), `${args.join(' ')}\n${r.out}`);
		return r;
	};
	const wcmd = (...args: string[]) => `node ../storage/node_modules/wrangler/bin/wrangler.js ${args.join(' ')} --persist-to <run>/persist`;
	/** Every statement's rows, in order. */
	const d1All = (envName: string, sqlText: string) => {
		const r = wrangler('d1', 'execute', 'DB', '--local', '--env', envName, '--json', '--command', sqlText);
		if (r.code !== 0) throw new Error(`wrangler d1 execute --env ${envName} failed: ${r.out.slice(-400)}`);
		return (JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as { results: Record<string, unknown>[] }[]).map((x) => x.results);
	};
	const d1 = (envName: string, sqlText: string) => d1All(envName, sqlText)[0]!;
	const d1File = (envName: string, file: string) => {
		const r = wrangler('d1', 'execute', 'DB', '--local', '--env', envName, '--yes', '--file', file);
		if (r.code !== 0) throw new Error(`wrangler d1 execute --env ${envName} --file ${path.basename(file)} failed: ${r.out.slice(-400)}`);
	};
	const userTables = "type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";
	const literal = (v: unknown) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
	/** The whole database as SQL, table by table through `wrangler d1 execute` (`d1 export --local` takes no --persist-to). */
	const dump = (envName: string) =>
		(d1(envName, `SELECT name, sql FROM sqlite_master WHERE ${userTables} ORDER BY rowid`) as { name: string; sql: string }[])
			.map((t) => [`${t.sql};`, ...(d1(envName, `SELECT * FROM ${t.name}`) as Record<string, unknown>[]).map((r) => `INSERT INTO ${t.name} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(literal).join(', ')});`)].join('\n'))
			.join('\n');
	const r2put = (envName: string, bucket: string, key: string, file: string) => wrangler('r2', 'object', 'put', `${bucket}/${key}`, '--local', '--env', envName, '--file', file);
	const identityFile = (client: string, label = '') => {
		const f = path.join(scratch, `identity-${client}${label}.json`);
		writeFileSync(f, JSON.stringify({ client_id: client }));
		return f;
	};

	const legs = Object.fromEntries(LEGS.map((n) => [n, { status: 'NOT RUN', commands: [], asserted: [], measured: {} } as Leg])) as Record<LegName, Leg>;
	const startedAt = new Date().toISOString();
	let artifact: string | null = null;
	let server: Server | null = null;
	const serve = async (envName: string) => {
		if (server) await stopServer(server);
		server = null;
		const args = [WRANGLER, 'dev', '--local', '--env', envName, '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false'];
		const child = spawn(node.path, args, { cwd: HERE, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const s: Server = { child, tree: [], label: envName };
		live.add(s);
		const log = createWriteStream(path.join(logs, `wrangler-dev-${envName}-${Date.now()}.log`));
		let text = '';
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${envName}: no "Ready on" within 45 s`)), 45_000);
			const onData = (b: Buffer) => {
				log.write(b);
				if (text.length < 1 << 16) text += b.toString();
				if (text.includes('Ready on')) (clearTimeout(timer), resolve());
			};
			child.stdout!.on('data', onData);
			child.stderr!.on('data', onData);
			child.once('exit', (c) => (clearTimeout(timer), reject(new Error(`${envName}: Wrangler exited ${c} before Ready: ${text.slice(-1500)}`))));
		});
		s.tree = descendants(child.pid!);
		if (!s.tree.some((p) => p.exe === 'workerd')) throw new Error(`${envName}: no native workerd under Wrangler`);
		server = s;
	};
	const serveCmd = (envName: string) => wcmd('dev', '--local', '--env', envName, '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', '0');

	async function leg(name: LegName, commands: string[], body: (check: (ok: boolean, what: string) => void, measure: Measure) => Promise<void>) {
		const l: Leg = { status: 'FAIL', commands, asserted: [], measured: {} };
		legs[name] = l;
		currentLeg = name;
		try {
			await body((ok, what) => {
				if (!ok) throw new Error(`assertion failed: ${what}`);
				l.asserted.push(what);
			}, l.measured);
			l.status = 'PASS';
		} catch (e) {
			l.failure = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	/** Flips one byte of every local R2 blob of `bucket` that has this size and SHA-256, as a credential holder with disk access could. */
	const flip = (bucket: string, size: number, digest: string, at: number) => {
		const dir = path.join(persist, 'v3/r2', bucket, 'blobs');
		let flipped = 0;
		for (const f of readdirSync(dir)) {
			const file = path.join(dir, f);
			if (statSync(file).size !== size || sha256(readFileSync(file)) !== digest) continue;
			const fd = openSync(file, 'r+');
			const b = Buffer.alloc(1);
			readSync(fd, b, 0, 1, at);
			b[0] = b[0]! ^ 0xff;
			writeSync(fd, b, 0, 1, at);
			closeSync(fd);
			flipped++;
		}
		return flipped;
	};
	/** The bytes of the local R2 blob of `bucket` with this size and SHA-256. */
	const blob = (bucket: string, size: number, digest: string) => {
		const dir = path.join(persist, 'v3/r2', bucket, 'blobs');
		for (const f of readdirSync(dir)) {
			const file = path.join(dir, f);
			if (statSync(file).size !== size) continue;
			const b = readFileSync(file);
			if (sha256(b) === digest) return new Uint8Array(b);
		}
		throw new Error(`no blob of ${size} bytes with that SHA-256 in ${bucket}`);
	};

	// ----- helpers over the Worker's routes -----
	const json = async (p: string) => (await http(p)).json();
	const liveOf = async (caseId: string) => json(`/probe/live/${caseId}`) as Promise<{ versions: { version_id: string; state: string }[]; active: string | null; originals: number; rev: number; work: Record<string, number> }>;
	const isGone = (l: Awaited<ReturnType<typeof liveOf>>) => l.versions.length === 0 && l.active === null && l.originals === 0 && l.rev === 0 && Object.values(l.work).every((n) => n === 0);
	const work = async (caseId: string) => (await http(`/cases/${caseId}/work`)).json() as { rev: number; tables: { uw_register_row: { columns: string[]; rows: Record<string, unknown>[] } } };
	const rowsOf = (w: Awaited<ReturnType<typeof work>>) => w.tables.uw_register_row.rows;
	const held = async (where: 'live' | 'copies', key: string) => (await http(`/recovery/head/${where}/${key}`)).status === 200;
	const addRow = async (caseId: string, text: string, anchor: string) => {
		const r = await post(`/cases/${caseId}/registers/notes/add`, { fields: { text, anchor, savedAt: new Date().toISOString() }, operationId: `op-${sha256(`${caseId} ${text}`).slice(0, 16)}` });
		if (r.status !== 200) throw new Error(`register add ${caseId}: ${r.status} ${r.text.slice(0, 200)}`);
		return r.json() as { rowId: string; seq: number; rev: number; version: string };
	};
	const putOriginal = async (caseId: string, o: Original) => {
		const p = await http(`/originals/${o.sha}`, { method: 'PUT', body: o.bytes as Uint8Array<ArrayBuffer> });
		const f = await post(`/cases/${caseId}/originals`, { assetId: o.assetId, sha256: o.sha, size: o.bytes.length, filename: o.filename, mediaType: 'application/pdf' });
		if (p.status !== 200 || f.status !== 200) throw new Error(`original ${o.assetId}: ${p.status} ${f.status} ${f.text.slice(0, 200)}`);
	};
	const fileText = (caseId: string, v: string, refs: string[]) => JSON.stringify({ synthetic: true, caseId, version: v, refs });
	const importVersion = async (caseId: string, v: string, refs: string[], originals: Original[]) => {
		const file = fileText(caseId, v, refs);
		const list = JSON.stringify(refs.map((ref) => ({ ref })));
		const documents = refs.map((ref) => ({ ref, row_json: JSON.stringify({ ref, name: `Synthetic document ${ref}` }) }));
		const assets = originals.map((o) => ({ asset_id: o.assetId, sha256: o.sha, size: o.bytes.length, kind: 'file' }));
		const steps = [
			await post(`/cases/${caseId}/versions/${v}/begin`, { expected: { documents: documents.length, assets: assets.length, seeds: 0, files: 1 }, list: { sha256: sha256(list), size: Buffer.byteLength(list) } }),
			await http(`/cases/${caseId}/versions/${v}/files/datasets/chronology.json`, { method: 'PUT', headers: { 'x-sha256': sha256(file) }, body: file }),
			await http(`/cases/${caseId}/versions/${v}/list`, { method: 'PUT', body: list }),
			await post(`/cases/${caseId}/versions/${v}/rows`, { table: 'document', strategy: 'json', rows: documents }),
			await post(`/cases/${caseId}/versions/${v}/rows`, { table: 'asset', strategy: 'json', rows: assets }),
			await post(`/cases/${caseId}/versions/${v}/finish`, {}),
		];
		const bad = steps.find((s) => s.status !== 200);
		if (bad) throw new Error(`import ${caseId} ${v}: ${bad.status} ${bad.text.slice(0, 300)}`);
		return { fileSha: sha256(file) };
	};
	const exportCase = async (caseId: string) => {
		const s = await post(`/cases/${caseId}/exports`, {});
		if (s.status !== 200) throw new Error(`export start ${caseId}: ${s.status} ${s.text.slice(0, 200)}`);
		const exportId = s.json().exportId as string;
		for (;;) {
			const st = await post(`/cases/${caseId}/exports/${exportId}/step`, {});
			if (st.status !== 200) throw new Error(`export step ${caseId}: ${st.status} ${st.text.slice(0, 200)}`);
			if (st.json().complete) break;
		}
		const sealed = await post(`/cases/${caseId}/exports/${exportId}/seal`, {});
		if (sealed.status !== 200) throw new Error(`export seal ${caseId}: ${sealed.status}`);
		return { exportId, sha256: sealed.json().sha256 as string, size: sealed.json().size as number };
	};
	const copyOf = async (caseId: string) => {
		const e = await exportCase(caseId);
		const c = await post('/recovery/copies', { caseId, exportId: e.exportId });
		if (c.status !== 200) throw new Error(`recovery copy ${caseId}: ${c.status} ${c.text.slice(0, 200)}`);
		await sleep(20); // copies a few milliseconds apart, so rotation can tell them apart
		return { ...e, copyId: c.json().copyId as string, uploaded: c.json().uploaded as string };
	};
	const upload = async (bytes: Uint8Array) => {
		const c = (await post('/restore/packets', {})).json();
		const part = await http(`/restore/packets/${c.packetId}/${c.uploadId}/1`, { method: 'PUT', body: bytes as Uint8Array<ArrayBuffer> });
		if (part.status !== 200 || (await post(`/restore/packets/${c.packetId}/${c.uploadId}/complete`, { parts: [part.json()] })).status !== 200) throw new Error('restore packet upload');
		return c.packetId as string;
	};
	/** GRS-109's restore of a packet, as far as it gets: each call's status and code. */
	const restorePacket = async (packetId: string, caseId: string, finish = true) => {
		const seen: Record<string, string> = {};
		const say = (step: string, r: Res) => ((seen[step] = `${r.status}${r.type.startsWith('application/json') && r.json().code ? ` ${r.json().code}` : ''}`), r.status === 200);
		if (!say('open', await post(`/restore/packets/${packetId}/open`, { caseId }))) return seen;
		for (let from = 1; ; ) {
			const s = await post(`/restore/packets/${packetId}/step`, { caseId, from }, 600_000);
			if (!say('step', s)) return seen;
			from = s.json().next;
			if (from >= s.json().of) break;
		}
		if (finish) say('finish', await post(`/restore/packets/${packetId}/finish`, { caseId }, 600_000));
		return seen;
	};
	/** A whole recovery-copy restore: stage the copy into the live bucket, then GRS-109's open, step and finish. */
	const restoreCopy = async (caseId: string, copyId: string) => {
		const s = await post(`/recovery/copies/${copyId}/stage`, { caseId });
		if (s.status !== 200) return { stage: `${s.status}${s.type.startsWith('application/json') ? ` ${s.json().code}` : ''}` };
		return { stage: '200', ...(await restorePacket(s.json().packetId, caseId)) };
	};
	const caseRoutes = (caseId: string): [string, () => Promise<Res>][] => [
		['GET document', () => http(`/cases/${caseId}/documents/S-0001`)],
		['GET original range', () => http(`/cases/${caseId}/originals/${oShared.assetId}`, { headers: { range: 'bytes=0-63' } })],
		['GET chronology', () => http(`/cases/${caseId}/chronology`)],
		['GET work', () => http(`/cases/${caseId}/work`)],
		['POST register add', () => post(`/cases/${caseId}/registers/notes/add`, { fields: { text: 'after removal' }, operationId: 'op-after-removal' })],
		['POST export', () => post(`/cases/${caseId}/exports`, {})],
		['POST finalize', () => post(`/cases/${caseId}/originals`, { assetId: oA1.assetId, sha256: oA1.sha, size: oA1.bytes.length, filename: oA1.filename, mediaType: 'application/pdf' })],
		['POST begin', () => post(`/cases/${caseId}/versions/${versionOf('after removal')}/begin`, { expected: { documents: 0, assets: 0, seeds: 0, files: 0 }, list: { sha256: '0'.repeat(64), size: 0 } })],
		['POST work restore', () => post(`/cases/${caseId}/work/restore`, { expectedRev: 0, snapshot: { format: 'clearcase.user-work/1', caseId, rev: 0, tables: {} } })],
	];
	/** Rows left for a case in every D1 table with a case_id, version_id or export_id column, read from sqlite_master by Wrangler's CLI, not by the Worker. */
	const residue = (envName: string, caseId: string, versions: string[], exports: string[]) => {
		const cols = d1(envName, "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name IN ('case_id', 'version_id', 'export_id') AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'") as { t: string; c: string }[];
		const list = (xs: string[]) => (xs.length ? xs.map((x) => `'${x}'`).join(', ') : "''");
		const where = (c: string) => (c === 'case_id' ? `case_id = '${caseId}'` : c === 'version_id' ? `version_id IN (${list(versions)})` : `export_id IN (${list(exports)})`);
		const parts = cols.filter((x) => x.t !== 'case_deletion').map((x) => `SELECT '${x.t}.${x.c}' AS t, count(*) AS n FROM ${x.t} WHERE ${where(x.c)}`);
		const rows = d1All(envName, parts.join('; ')).flat() as { t: string; n: number }[];
		return { tables: new Set(cols.map((x) => x.t)).size, left: rows.filter((r) => r.n > 0).map((r) => `${r.t}: ${r.n}`) };
	};

	let failure: string | null = null;
	try {
		await leg('build', ['bun run --bun build'], async (check, m) => {
			rmSync(path.join(HERE, 'dist'), { recursive: true, force: true });
			const r = run(process.execPath, ['run', '--bun', 'build'], { env: { PATH: env.PATH!, HOME: env.HOME! } });
			writeFileSync(path.join(logs, 'build.log'), r.out);
			check(r.code === 0, `bun build of src/worker.ts, with GRS-109's storage Worker imported whole, exits 0 offline under Bun ${process.versions.bun}`);
			const worker = path.join(HERE, 'dist/worker.js');
			check(existsSync(worker), 'the Worker module dist/worker.js exists');
			const bytes = readFileSync(worker);
			check(!/node:|bun:|require\(/.test(bytes.toString('utf8')), 'the bundle imports no node:, bun: or CommonJS module');
			artifact = `sha256:${sha256(bytes)}`;
			m.workerBytes = bytes.length;
		});

		const storageSchema = path.join(STORAGE, 'schema.sql');
		const statements = [storageSchema, path.join(HERE, 'schema.sql')].map((f) => readFileSync(f, 'utf8').split(';').filter((s) => s.replace(/--.*$/gm, '').trim()).length).reduce((a, b) => a + b);
		await leg('provision', [wcmd('d1 execute DB --local --env {client-a,client-b,recovered-a} --file ../storage/schema.sql'), wcmd('d1 execute DB --local --env {client-a,client-b,recovered-a} --file schema.sql'), wcmd('d1 execute DB --local --env … --command "INSERT INTO storage_identity …"'), wcmd('r2 object put {recovery-a,recovery-b,recovered-a,recovery-copies-a}/identity/client.json --local')], async (check, m) => {
			for (const e of ['client-a', 'client-b', 'recovered-a']) {
				for (const file of [storageSchema, path.join(HERE, 'schema.sql')]) {
					const r = wrangler('d1', 'execute', 'DB', '--local', '--env', e, '--yes', '--file', file);
					if (r.code !== 0) throw new Error(`schema ${path.basename(path.dirname(file))}/${path.basename(file)} for ${e}: ${r.out.slice(-400)}`);
				}
			}
			check(true, "GRS-109's schema.sql and this probe's schema.sql apply to the three deployments' local D1 databases in their own process");
			for (const [e, client, bucket] of [['client-a', 'client-a', 'recovery-a'], ['client-b', 'client-b', 'recovery-b'], ['recovered-a', 'client-a', 'recovered-a']] as const) {
				d1(e, `INSERT INTO storage_identity (singleton, client_id, layout) VALUES (1, '${client}', 'one-database-per-client/1')`);
				if (r2put(e, bucket, 'identity/client.json', identityFile(client)).code !== 0) throw new Error(`identity object for ${e}`);
			}
			if (r2put('client-a', 'recovery-copies-a', 'identity/client.json', identityFile('client-a', '-recovery')).code !== 0) throw new Error("identity object for client A's recovery bucket");
			check(d1('client-a', 'SELECT client_id FROM storage_identity')[0]?.client_id === 'client-a' && d1('recovered-a', 'SELECT client_id FROM storage_identity')[0]?.client_id === 'client-a', "client A's live database and its fresh replacement each hold client A's identity row");
			check(d1('client-a', "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('case_deletion', 'bundle_version')")[0]?.n === 2, 'the recovery tables exist beside the storage tables');
			m.deployments = 3;
			m.schemaStatements = statements;
		});

		await leg('crossed-recovery', [serveCmd('client-b'), 'GET /recovery/copies before and after recovery-copies-b/identity/client.json', serveCmd('crossed-recovery'), 'GET /recovery/copies, GET /cases/<case>/documents/<ref>, POST /cases/<case>/deletion/request'], async (check, m) => {
			let refused = 0;
			const expectRefused = async (r: Promise<Res>, c: string) => {
				const res = await r;
				const ok = res.status === 503 && res.json().code === c && res.json().binding === 'RECOVERY' && !res.text.includes('client-b');
				if (ok) refused++;
				return ok;
			};
			await serve('client-b');
			check(await expectRefused(http('/recovery/copies'), 'missing-identity'), 'a deployment whose recovery bucket has no identity object answers 503 missing-identity naming RECOVERY (fail-closed on a missing field)');
			if (r2put('client-b', 'recovery-copies-b', 'identity/client.json', identityFile('client-b', '-recovery')).code !== 0) throw new Error("identity object for client B's recovery bucket");
			await serve('client-b');
			check((await http('/recovery/copies')).status === 200, "once its recovery bucket carries client B's identity, client B's deployment answers");
			check(code(await post('/recovery/rotate', { scheduledTime: new Date(Date.now() + 400 * DAY).toISOString() }), 404, 'not-found') && ((await http('/recovery/copies')).json() as unknown[]).length === 0, 'a deployment without the probe clock has no rotation route: a time named in a request is not accepted, and nothing is removed');
			await serve('crossed-recovery');
			check((await expectRefused(http('/recovery/copies'), 'crossed-binding')) && (await expectRefused(http(`/cases/${A1}/documents/S-0001`), 'crossed-binding')) && (await expectRefused(post(`/cases/${A1}/deletion/request`, { actor: { role: 'firm-admin', id: 'fa-1' } }), 'crossed-binding')), "client A's Worker bound to client B's recovery bucket answers 503 crossed-binding naming RECOVERY on recovery, case and deletion routes, and never names client B");
			check(d1('client-a', 'SELECT count(*) AS n FROM case_deletion')[0]?.n === 0, 'the crossed deployment wrote nothing to client A');
			m.refusedRequests = refused;
		});

		// ----- two cases of client A that share one original -----
		await serve('client-a');
		const seed = { workA1: [] as string[], workA2: [] as string[] };
		await leg('seed', ['PUT /originals/<sha256>, POST /cases/<case>/originals (3 originals, one finalized for both cases)', 'POST /cases/<case>/versions/<v>/begin, PUT …/files/…, PUT …/list, POST …/rows, POST …/finish', 'POST /cases/<case>/activate', 'POST /cases/<case>/registers/notes/add (rows with savedAt)', 'PUT /cases/<case>/bundles/<id> (bundle history)', 'GET /probe/live/<case>'], async (check, m) => {
			for (const o of [oA1, oShared]) await putOriginal(A1, o);
			for (const o of [oShared, oA2]) await putOriginal(A2, o);
			await importVersion(A1, V1, ['S-0001', 'S-0002'], [oA1, oShared]);
			await importVersion(A2, VB, ['S-0001', 'S-0002'], [oShared, oA2]);
			const act = [await post(`/cases/${A1}/activate`, { version: V1, expected: null }), await post(`/cases/${A2}/activate`, { version: VB, expected: null })];
			check(act.every((r) => r.status === 200), 'both cases activate their first results version');
			for (const [c, text, anchor] of [[A1, 'A1 first note', 'S-0001'], [A1, 'A1 second note', 'S-0002'], [A2, 'A2 first note', 'S-0001'], [A2, 'A2 second note', 'S-0002'], [A2, 'A2 third note', 'S-0001']] as const) (c === A1 ? seed.workA1 : seed.workA2).push((await addRow(c, text, anchor)).rowId);
			const bundle = synthetic('recovery probe A2 bundle version 1', 100);
			const bundleA1 = synthetic('recovery probe A1 bundle version 1', 100);
			check((await http(`/cases/${A2}/bundles/b-1`, { method: 'PUT', headers: { 'x-sha256': sha256(bundle) }, body: bundle })).status === 200 && (await http(`/cases/${A1}/bundles/b-1`, { method: 'PUT', headers: { 'x-sha256': sha256(bundleA1) }, body: bundleA1 })).status === 200, 'each case stores one bundle version in its bundle history');
			const [l1, l2] = [await liveOf(A1), await liveOf(A2)];
			check(l1.active === V1 && l1.originals === 2 && l1.work.uw_register_row === 2 && l2.active === VB && l2.originals === 2 && l2.work.uw_register_row === 3, 'A1 holds V1, 2 originals and 2 rows; A2 holds its version, 2 originals and 3 rows');
			const shared = await http(`/cases/${A2}/originals/${oShared.assetId}`);
			check(shared.status === 200 && sha256(shared.bytes) === oShared.sha && shared.headers.get('etag') === `"${oShared.sha}"`, 'the original both cases record is one object, orig/<sha256>, served verified to A2');
			check((await http(`/cases/${A1}/originals/${oShared.assetId}`)).status === 200, 'and to A1');
			Object.assign(m, { cases: 2, originals: 3, sharedOriginals: 1, workRows: seed.workA1.length + seed.workA2.length });
		});

		// ----- publication rollback: the active pointer moves back; user work and every object stay -----
		await leg('rollback', ['import V2 of A1 (a third document, another package file), POST /cases/<A1>/activate {V2, expected V1}', 'POST …/registers/notes/add anchored to the new document; …/replace of a V1 row', 'POST /cases/<A1>/activate {V1, expected V2} (the rollback), then again with the stale expectation', 'GET /cases/<A1>/work, …/documents/<ref>, …/versions/<v>/files/<path>, …/originals/<asset>, /probe/head/<key>', 'POST /cases/<A1>/activate {V2, expected V1} (roll forward)'], async (check, m) => {
			const v1Sha = sha256(fileText(A1, V1, ['S-0001', 'S-0002']));
			const v2 = await importVersion(A1, V2, ['S-0001', 'S-0002', 'S-0003'], [oA1, oShared]);
			check((await post(`/cases/${A1}/activate`, { version: V2, expected: V1 })).status === 200, 'V2 is published over V1 in one guarded batch');
			const anchored = await addRow(A1, 'A1 note on the V2-only document', 'S-0003');
			const before = rowsOf(await work(A1)).find((r) => r.row_id === seed.workA1[0])!;
			const replaced = await post(`/cases/${A1}/registers/notes/replace`, { rowId: seed.workA1[0], expected: before.version, fields: { text: 'A1 first note, edited under V2', anchor: 'S-0001', savedAt: new Date().toISOString() } });
			check(replaced.status === 200 && replaced.json().kind === 'written', 'a V1 row is edited under V2 with its expected version');
			const w = await work(A1);
			const back = await post(`/cases/${A1}/activate`, { version: V1, expected: V2 });
			check(back.status === 200 && (await liveOf(A1)).active === V1, 'the rollback publishes V1 again in one guarded batch');
			const after = await work(A1);
			check(JSON.stringify(after) === JSON.stringify(w), 'user work after the rollback is byte for byte what it was before it: every row id, seq, version, field and savedAt timestamp, and the case revision');
			check(rowsOf(after).some((r) => r.row_id === anchored.rowId && JSON.parse(r.fields as string).anchor === 'S-0003') && (await http(`/cases/${A1}/documents/S-0003`)).status === 404, 'the row anchored to the V2-only document is kept while V1, which lacks that document, is published');
			const f1 = await http(`/cases/${A1}/versions/${V1}/files/datasets/chronology.json`);
			check(f1.status === 200 && sha256(f1.bytes) === v1Sha && (await http(`/cases/${A1}/versions/${V2}/files/datasets/chronology.json`)).status === 404, "V1's package file is served with V1's SHA-256, and V2's is not served while V1 is published");
			const v2Kept = await http(`/probe/head/pkg/${V2}/datasets/chronology.json`);
			check(v2Kept.status === 200 && v2Kept.json().sha256 === v2.fileSha && (await http(`/probe/head/rm/${V2}/chronology.json`)).status === 200, "V2's objects stay in R2 with their SHA-256: a rollback deletes nothing");
			const o = await http(`/cases/${A1}/originals/${oA1.assetId}`);
			check(o.status === 200 && sha256(o.bytes) === oA1.sha && o.headers.get('etag') === `"${oA1.sha}"`, 'the originals are the same objects, orig/<sha256>, under either version');
			const logBeforeStale = d1('client-a', `SELECT count(*) AS n FROM activation_log WHERE case_id = '${A1}'`)[0]!.n as number;
			const stale = await post(`/cases/${A1}/activate`, { version: V1, expected: V2 });
			const staleRefused = code(stale, 409, 'stale-or-unstored') && (d1('client-a', `SELECT count(*) AS n FROM activation_log WHERE case_id = '${A1}'`)[0]!.n as number) === logBeforeStale && JSON.stringify(await work(A1)) === JSON.stringify(w);
			check(staleRefused, 'a second rollback with the stale expectation answers 409 stale-or-unstored and changes nothing: no activation is logged and user work is as it was');
			const next = await addRow(A1, 'A1 note after the rollback', 'S-0001');
			check(next.seq === Math.max(...rowsOf(w).map((r) => r.seq as number)) + 1 && next.rev === w.rev + 1, 'the next write after the rollback takes the next seq and revision: no gap, no reuse');
			check((await post(`/cases/${A1}/activate`, { version: V2, expected: V1 })).status === 200 && (await http(`/cases/${A1}/documents/S-0003`)).status === 200 && rowsOf(await work(A1)).length === rowsOf(w).length + 1, 'rolling forward to V2 serves the V2-only document again, with every row kept');
			const log = d1('client-a', `SELECT count(*) AS n FROM activation_log WHERE case_id = '${A1}'`)[0]!.n as number;
			check(log === 4, 'the activation log records each of the four publications');
			Object.assign(m, { activations: log, workRowsKept: rowsOf(w).length, staleRefused: staleRefused ? 1 : 0 });
		});

		// ----- rolling recovery copies, apart from live data -----
		const copies: Record<string, Awaited<ReturnType<typeof copyOf>>> = {};
		const atCopy = { stateA2: '', workA2: '', rowsA2: 0 };
		let stagedA1 = ''; // the packet of an aborted restore of A1, made before A1's removal
		let t0Dump = '';
		await leg('copies', ['POST /cases/<case>/exports, …/step, …/seal (GRS-109\'s case backup)', 'POST /recovery/copies {caseId, exportId}', 'GET /recovery/copies, GET /recovery/head/{live,copies}/<key>', 'a byte of one copy flipped in its local R2 blob, then POST /recovery/copies/<id>/stage', wcmd('d1 execute DB --local --env client-a --json --command "SELECT … FROM <each table sqlite_master lists>"') + ' > <run>/scratch/t0.sql'], async (check, m) => {
			copies.a1first = await copyOf(A1);
			copies.a1second = await copyOf(A1);
			copies.a2 = await copyOf(A2);
			atCopy.stateA2 = (await json(`/cases/${A2}/state`)).sha256;
			atCopy.workA2 = JSON.stringify(rowsOf(await work(A2)));
			atCopy.rowsA2 = rowsOf(await work(A2)).length;
			await addRow(A2, 'A2 note after the copy', 'S-0002');
			copies.broken = await copyOf(A2); // one row more than copies.a2, so the two backups differ byte for byte
			const listed = (await json('/recovery/copies')) as { key: string; caseId: string; sha256: string; size: number }[];
			check(listed.length === 4 && Object.values(copies).every((c) => listed.some((l) => l.key.endsWith(`/${c.copyId}.zip`) && l.sha256 === c.sha256 && l.size === c.size)), "four recovery copies are in RECOVERY under recovery/<case>/<copy>.zip, each with its case backup's SHA-256 and size");
			const key = (c: { copyId: string }, caseId: string) => `recovery/${caseId}/${c.copyId}.zip`;
			check(!(await held('live', key(copies.a1first!, A1))) && (await held('copies', key(copies.a1first!, A1))) && (await held('live', `export/${A1}/${copies.a1first!.exportId}.zip`)), 'a copy is held only in the recovery bucket; the live bucket keeps its own export');
			check(flip('recovery-copies-a', copies.broken.size, copies.broken.sha256, Math.floor(copies.broken.size / 2)) === 1, 'one byte in the middle of one copy is flipped at rest');
			const staged = await post(`/recovery/copies/${copies.broken.copyId}/stage`, { caseId: A2 });
			const corruptedRefused = code(staged, 422, 'copy-corrupted');
			check(corruptedRefused, 'staging the corrupted copy answers 422 copy-corrupted: R2 refused the write against the SHA-256 recorded at copy time');
			const aborted = await post(`/recovery/copies/${copies.a1second!.copyId}/stage`, { caseId: A1 });
			stagedA1 = aborted.status === 200 ? (aborted.json().packetId as string) : '';
			check(stagedA1 !== '' && (await held('live', `import/${stagedA1}.zip`)), "A1's second copy is staged into the live bucket ahead of a restore that is never finished: the packet holds A1's originals, read model and user work");
			await addRow(A2, 'A2 second note after the copy', 'S-0002');
			const rowsAfterCopy = rowsOf(await work(A2)).length - atCopy.rowsA2;
			check(rowsAfterCopy === 2, 'A2 gains two rows after its copy');
			t0Dump = path.join(scratch, 't0.sql');
			writeFileSync(t0Dump, dump('client-a'));
			check(readFileSync(t0Dump, 'utf8').includes(`'${A1}'`), "client A's whole database is dumped, the stand-in for a D1 Time Travel point, before any deletion");
			Object.assign(m, { copies: listed.length, corruptedCopiesRefused: corruptedRefused ? 1 : 0, rowsAfterCopy });
		});

		// ----- deletion: request, approval, export offer, removal -----
		const deleted = { versions: [V1, V2], exports: [] as string[], removedAt: '' };
		let stateA2BeforeRemoval = '';
		await leg('deletion-flow', ['POST /cases/<A1>/deletion/request {actor firm-admin}', 'POST /cases/<A1>/deletion/approve {actor global-admin}', 'POST /cases/<A1>/exports … seal, POST /cases/<A1>/deletion/offer {exportId}, GET /cases/<A1>/exports/<id>', 'POST /cases/<A1>/deletion/remove {actor global-admin}', 'every case route of A1; GET /probe/live/<A1>; GET /recovery/head/live/<key>', wcmd('d1 execute DB --local --env client-a --command "<every table with a case_id, version_id or export_id column>"')], async (check, m) => {
			await addRow(A2, 'A2 note after the database dump', 'S-0001'); // lost by the rollback in deletion-reapply
			let refused = 0;
			const no = (r: Res, status: number, c: string, extra = true) => (code(r, status, c) && extra ? (refused++, true) : false);
			const step = (s: string, actor: unknown, extra: Record<string, unknown> = {}) => post(`/cases/${A1}/deletion/${s}`, { ...(actor === undefined ? {} : { actor }), ...extra });
			const FA = { role: 'firm-admin', id: 'fa-1' };
			const GA = { role: 'global-admin', id: 'ga-1' };
			check(no(await step('request', GA), 403, 'wrong-role') && no(await step('request', undefined), 400, 'invalid-field') && no(await step('request', { role: 'firm-admin' }), 400, 'invalid-field') && no(await post(`/cases/case-recovery-none/deletion/request`, { actor: FA }), 404, 'no-such-case') && no(await step('approve', GA), 409, 'wrong-state'), 'a request by a Global Admin, with no actor or no actor id, for an unknown case, and an approval with no request are refused, naming the field or the state');
			const req = await step('request', FA);
			check(req.status === 200 && req.json().state === 'requested' && req.json().requested_by === 'firm-admin:fa-1' && ISO.test(req.json().requested_at), "the firm admin's request is recorded with its actor and time");
			check((await http(`/cases/${A1}/documents/S-0001`)).status === 200, 'live access continues while the deletion is only requested');
			check(no(await step('approve', FA), 403, 'wrong-role') && no(await step('offer', GA, { exportId: crypto.randomUUID() }), 409, 'wrong-state') && no(await step('remove', GA), 409, 'wrong-state'), 'the firm admin cannot approve, and nothing can be offered or removed before approval');
			const ap = await step('approve', GA);
			check(ap.status === 200 && ap.json().state === 'approved' && ap.json().approved_by === 'global-admin:ga-1', "the Global Admin's approval is recorded");
			check(no(await step('remove', GA), 409, 'wrong-state'), 'removal before the export is offered is refused');
			const unsealed = (await post(`/cases/${A1}/exports`, {})).json().exportId as string;
			const other = await exportCase(A2);
			check(no(await step('offer', GA, { exportId: unsealed }), 409, 'export-not-sealed') && no(await step('offer', GA, { exportId: other.exportId }), 404, 'no-such-export'), "an unsealed export, and another case's export, cannot be offered");
			const offered = await exportCase(A1);
			deleted.exports.push(unsealed, offered.exportId, copies.a1first!.exportId, copies.a1second!.exportId);
			const of = await step('offer', GA, { exportId: offered.exportId });
			check(of.status === 200 && of.json().state === 'offered' && of.json().export_sha256 === offered.sha256, 'the sealed export of A1 is offered, with its SHA-256');
			const dl = await http(`/cases/${A1}/exports/${offered.exportId}`);
			check(dl.status === 200 && sha256(dl.bytes) === offered.sha256, 'the firm downloads the offered export, byte for byte');
			stateA2BeforeRemoval = (await json(`/cases/${A2}/state`)).sha256;
			const rm = await step('remove', GA);
			check(rm.status === 200 && rm.json().state === 'removed' && rm.json().repeated === false, 'the Global Admin removes the case');
			deleted.removedAt = (await json(`/cases/${A1}/deletion`)).removed_at;
			let gone = 0;
			const answers: string[] = [];
			for (const [label, request] of caseRoutes(A1)) {
				const r = await request();
				if (code(r, 410, 'case-deleted') && !r.text.includes('SYNTHETIC')) gone++;
				else answers.push(`${label} ${r.status}`);
			}
			check(gone === caseRoutes(A1).length, `every case route of A1 answers 410 case-deleted with no case bytes (${answers.join(', ')})`);
			check(isGone(await liveOf(A1)), 'A1 holds no version, activation, original, revision or user-work row');
			const res = residue('client-a', A1, deleted.versions, deleted.exports);
			check(res.left.length === 0 && res.tables > 10, `no row of A1, its versions or its exports is left in any of the ${res.tables} tables sqlite_master lists with such a column (${res.left.join(', ')})`);
			const objects = [`pkg/${V1}/datasets/chronology.json`, `pkg/${V2}/datasets/chronology.json`, `rm/${V1}/chronology.json`, `rm/${V2}/chronology.json`, `export/${A1}/${offered.exportId}.zip`, `bundle/${A1}/b-1.pdf`, `orig/${oA1.sha}`, `import/${stagedA1}.zip`];
			const left = [];
			for (const k of objects) if (await held('live', k)) left.push(k);
			check(left.length === 0, `A1's package files, lists, exports, bundle history, its own original and the packet of its aborted restore are erased from the live bucket (${left.join(', ')})`);
			const shared = await http(`/cases/${A2}/originals/${oShared.assetId}`);
			check(shared.status === 200 && sha256(shared.bytes) === oShared.sha && (await json(`/cases/${A2}/state`)).sha256 === stateA2BeforeRemoval, 'the original A2 also records stays and A2 serves it verified; everything of A2 is as it was');
			const again = await step('remove', GA);
			check(again.status === 200 && again.json().repeated === true && no(await step('request', FA), 409, 'wrong-state'), 'a repeated removal is a no-op that erases what may be left, and a new request on the removed case is refused');
			const d = await json(`/cases/${A1}/deletion`);
			check(d.state === 'removed' && d.removed_by === 'global-admin:ga-1' && d.requested_at <= d.approved_at && d.approved_at <= d.offered_at && d.offered_at <= d.removed_at, 'the deletion keeps its actors and its request, approval, offer and removal times, in that order');
			Object.assign(m, { refusedSteps: refused, routesGone: gone, erasedObjects: rm.json().objects as number, residueRows: res.left.length });
		});

		// ----- a restore never brings a deleted case back -----
		await leg('deletion-reapply', [`POST /recovery/copies/<A1's earlier copy>/stage, then POST /restore/packets/<id>/open, …/step, …/finish`, `the same copy, read from its local blob, uploaded through POST /restore/packets and restored`, 'POST /cases/<A1>/work/restore', 'GET /recovery/ledger, GET /recovery/head/{live,copies}/deletion/<A1>.json', wcmd('d1 execute DB --local --env client-a --file <run>/scratch/rollback.sql (every table dropped, then the earlier dump)'), 'GET /cases/<A1>/documents/<ref> under the same running Worker, then the D1 state through Wrangler'], async (check, m) => {
			let refused = 0;
			const first = await restoreCopy(A1, copies.a1first!.copyId);
			const after = await liveOf(A1);
			check(first.stage === '409 case-deleted' && isGone(after), `restoring A1's earlier recovery copy, made before the deletion, is refused and A1 stays deleted (${JSON.stringify(first)}; A1 now: active ${after.active}, ${after.originals} originals, ${after.work.uw_register_row ?? 0} rows)`);
			refused++;
			const raw = await upload(blob('recovery-copies-a', copies.a1second!.size, copies.a1second!.sha256));
			const viaPacket = await restorePacket(raw, A1);
			check(viaPacket.open === '409 case-deleted' && isGone(await liveOf(A1)), `the same backup uploaded as a restore packet is refused at open and nothing is written (${JSON.stringify(viaPacket)})`);
			const stepFinish = [await post(`/restore/packets/${raw}/step`, { caseId: A1, from: 1 }), await post(`/restore/packets/${raw}/finish`, { caseId: A1 })];
			check(stepFinish.every((r) => code(r, 409, 'case-deleted')) && isGone(await liveOf(A1)) && !(await held('live', `import/${raw}.zip`)), "step and finish of that packet are refused as well, and the packet, which holds the deleted case's data, is deleted");
			refused += 3;
			const wr = await post(`/cases/${A1}/work/restore`, { expectedRev: 0, snapshot: { format: 'clearcase.user-work/1', caseId: A1, rev: 0, tables: {} } });
			check(code(wr, 410, 'case-deleted'), 'a user-work restore into the removed case answers 410 case-deleted');
			refused++;
			const ledger = (await json('/recovery/ledger')) as Record<string, unknown>[];
			const record = ledger.find((r) => r.caseId === A1);
			check(ledger.length === 1 && isObject(record) && Object.keys(record).sort().join() === 'approvedAt,approvedBy,caseId,client,format,offeredExport,removedAt,removedBy,requestedAt,requestedBy' && record.client === 'client-a' && record.removedAt === deleted.removedAt && !JSON.stringify(record).includes('SYNTHETIC'), 'the deletion record holds ids, roles and times only, no case content');
			check((await held('live', `deletion/${A1}.json`)) && (await held('copies', `deletion/${A1}.json`)), 'it is kept in the live bucket and in the recovery bucket, beside the copies it governs');
			// D1 Time Travel restores the whole database in place while isolates keep running; the earlier dump stands in for it.
			const rowsBeforeRollback = rowsOf(await work(A2)).length;
			const tables = (d1('client-a', `SELECT name FROM sqlite_master WHERE ${userTables} ORDER BY rowid`) as { name: string }[]).map((t) => t.name);
			const rollback = path.join(scratch, 'rollback.sql');
			writeFileSync(rollback, `${[...tables].reverse().map((t) => `DROP TABLE ${t};`).join('\n')}\n${readFileSync(t0Dump, 'utf8')}`);
			d1File('client-a', rollback);
			const revived = d1('client-a', `SELECT (SELECT count(*) FROM active WHERE case_id = '${A1}') AS active, (SELECT count(*) FROM case_deletion WHERE case_id = '${A1}') AS deletion, (SELECT count(*) FROM uw_register_row WHERE case_id = '${A2}') AS a2rows`)[0]!;
			check(revived.active === 1 && revived.deletion === 0 && revived.a2rows === 5, "the rolled-back database holds A1 live again, with no deletion, and A2 as it was at the dump (its later row lost)");
			const doc = await http(`/cases/${A1}/documents/S-0001`);
			const reapplied = d1('client-a', `SELECT (SELECT state FROM case_deletion WHERE case_id = '${A1}') AS state, (SELECT count(*) FROM active WHERE case_id = '${A1}') AS active, (SELECT count(*) FROM results_version WHERE case_id = '${A1}') AS versions`)[0]!;
			const reappliedOk = code(doc, 410, 'case-deleted') && reapplied.state === 'removed' && reapplied.active === 0 && reapplied.versions === 0 && residue('client-a', A1, deleted.versions, deleted.exports).left.length === 0;
			check(reappliedOk, `the running Worker's next request for A1 finds its record in the buckets while D1 holds A1 live, reapplies the deletion, and answers 410 (${doc.status}, ${JSON.stringify(reapplied)})`);
			check((await http(`/cases/${A2}/state`)).status === 200 && rowsOf(await work(A2)).length === 5, 'A2 is served from the rolled-back database, without the row written after the dump');
			Object.assign(m, { restoresRefused: refused, rollbackLostRows: rowsBeforeRollback - (revived.a2rows as number), reappliedAfterRollback: reappliedOk });
		});

		// ----- client A's live database and bucket are lost: a fresh deployment restores from the recovery copies -----
		await serve('recovered-a');
		await leg('restore-from-copy', [serveCmd('recovered-a'), 'GET /recovery/copies', `POST /recovery/copies/<A1's copy>/stage`, "A2's copy with one byte of an original flipped, read from its blob and uploaded through POST /restore/packets, then …/step", "POST /recovery/copies/<A2's copy>/stage, POST /restore/packets/<id>/open, …/step, …/finish", 'GET /cases/<A2>/state, …/verify, …/work, …/originals/<asset>', "a byte of a restored original flipped in recovered-a's local R2 blob, then GET …/originals/<asset> with Range"], async (check, m) => {
			const t0 = performance.now();
			const rowsAtLoss = d1('client-a', `SELECT count(*) AS n FROM uw_register_row WHERE case_id = '${A2}'`)[0]!.n as number; // what the lost deployment held
			const listed = (await json('/recovery/copies')) as { key: string }[];
			check(listed.length === 4, "the fresh deployment sees client A's four recovery copies");
			const a1 = await restoreCopy(A1, copies.a1second!.copyId);
			check(a1.stage === '409 case-deleted' && isGone(await liveOf(A1)) && code(await http(`/cases/${A1}/documents/S-0001`), 410, 'case-deleted'), `the fresh deployment, whose own database never saw the deletion, refuses A1's copy: the deletion record travels with the copies (${JSON.stringify(a1)})`);
			const good = blob('recovery-copies-a', copies.a2!.size, copies.a2!.sha256);
			const at = Buffer.from(good).indexOf(Buffer.from(oA2.bytes));
			const broken = new Uint8Array(good);
			broken[at + 100] = broken[at + 100]! ^ 0xff;
			const brokenRun = await restorePacket(await upload(broken), A2);
			check(at > 0 && brokenRun.open === '200' && brokenRun.step === '422 crc-mismatch' && (await liveOf(A2)).active === null, `a backup whose original entry changed between export and restore is refused by its CRC-32 before that original is written, and A2 is not activated (${JSON.stringify(brokenRun)})`);
			const tStage = performance.now();
			const staged = await post(`/recovery/copies/${copies.a2!.copyId}/stage`, { caseId: A2 });
			check(staged.status === 200 && staged.json().sha256 === copies.a2!.sha256, "A2's copy is staged into the fresh live bucket, R2 checking its SHA-256 as it is written");
			const stageMs = ms(tStage);
			const tRestore = performance.now();
			const run2 = await restorePacket(staged.json().packetId, A2);
			const restoreMs = ms(tRestore);
			check(run2.open === '200' && run2.step === '200' && run2.finish === '200', `GRS-109's restore opens, copies and finishes it (${JSON.stringify(run2)})`);
			check(!(await held('live', `import/${staged.json().packetId}.zip`)), "the staged packet is deleted once its restore finishes with 200: the fresh bucket keeps the restored case's objects, not a second copy of the backup");
			const tChecks = performance.now();
			check((await json(`/cases/${A2}/state`)).sha256 === atCopy.stateA2, "A2's state digest in the fresh deployment equals the source's at copy time: rows, read model, user work and every object");
			const v = await http(`/cases/${A2}/verify`);
			check(v.status === 200 && v.json().ok === true, "every package file and the list of A2's published version hash to their recorded SHA-256 (GRS-12's check)");
			let exact = 0;
			for (const o of [oShared, oA2]) {
				const r = await http(`/cases/${A2}/originals/${o.assetId}`);
				if (r.status === 200 && sha256(r.bytes) === o.sha && r.headers.get('etag') === `"${o.sha}"` && (await http(`/probe/head/orig/${o.sha}`)).json().sha256 === o.sha) exact++;
			}
			check(exact === 2, "every acknowledged original of A2, the shared one included, comes back byte for byte under its own key orig/<sha256>");
			const restoredRows = JSON.stringify(rowsOf(await work(A2)));
			check(restoredRows === atCopy.workA2, "A2's user work is exactly the copy's: every row id, seq, version and savedAt timestamp");
			const lostRowsAfterCopy = rowsAtLoss - (JSON.parse(restoredRows) as unknown[]).length;
			check(lostRowsAfterCopy === 2, 'the two rows written after the copy are not in it: a copy restore loses what was written since the copy (Time Travel is the one-hour RPO path, HOLD)');
			const r = await http(`/cases/${A2}/originals/${oA2.assetId}`, { headers: { range: 'bytes=0-63' } });
			check(r.status === 206 && Buffer.from(r.bytes).equals(Buffer.from(oA2.bytes.subarray(0, 64))), 'a range of a restored original is served from its verified bytes');
			check(flip('recovered-a', oA2.bytes.length, oA2.sha, 100) === 1, "one byte of a restored original is flipped at rest in the fresh deployment's bucket");
			const bad = await http(`/cases/${A2}/originals/${oA2.assetId}`, { headers: { range: 'bytes=0-63' } });
			check(code(bad, 410, 'changed-original') && !bad.text.includes('SYNTHETIC'), 'the same range then answers 410 changed-original with no original bytes: the corruption checks hold on restored data');
			const checksMs = ms(tChecks);
			check(d1('recovered-a', `SELECT state FROM case_deletion WHERE case_id = '${A1}'`)[0]?.state === 'removed', "the fresh deployment's database now carries A1's deletion as removed");
			Object.assign(m, { restoredOriginals: exact, lostRowsAfterCopy, stageMs, restoreMs, checksMs, totalMs: ms(t0) });
		});

		// ----- rotation: copies age out after 30 days; live data, bundle history and deletion records stay -----
		await serve('client-a');
		await leg('retention', ['POST /recovery/rotate {scheduledTime} at the first copy + 30 days - 1 ms, + 30 days + 1 ms, the removal + 30 days + 1 ms and + 400 days', 'POST /recovery/rotate with no or a malformed scheduledTime', 'GET /recovery/copies, GET /recovery/head/{live,copies}/<key>', 'POST /cases/<A2>/deletion/request, then rotation at + 400 days', 'GET /cases/<A2>/verify, …/originals/<asset>, …/work, …/bundles, …/documents/<ref>'], async (check, m) => {
			let rotations = 0;
			let removed = 0;
			const rotate = async (at: number) => {
				const r = await post('/recovery/rotate', { scheduledTime: new Date(at).toISOString() });
				if (r.status !== 200) throw new Error(`rotate: ${r.status} ${r.text.slice(0, 200)}`);
				rotations++;
				removed += (r.json().removed as string[]).length;
				return r.json() as { removed: string[]; kept: number };
			};
			const orphan = await upload(synthetic('recovery probe packet nobody tagged', 50)); // GRS-109's own upload: it names no case until it is opened
			const orphanHeld = await held('live', `import/${orphan}.zip`);
			const c1 = Date.parse(copies.a1first!.uploaded);
			check((await rotate(c1 + 30 * DAY - 1)).removed.length === 0, 'at its first copy + 30 days - 1 ms rotation removes nothing');
			const r1 = await rotate(c1 + 30 * DAY + 1);
			check(r1.removed.length === 1 && r1.removed[0] === `recovery/${A1}/${copies.a1first!.copyId}.zip` && r1.kept === 3, 'at + 30 days + 1 ms it removes that copy only; the younger copies stay (rolling)');
			const removedAt = Date.parse(deleted.removedAt);
			const r2 = await rotate(removedAt + 30 * DAY + 1);
			const orphanAtR2 = await held('live', `import/${orphan}.zip`);
			check(r2.kept === 0 && !(await json('/recovery/copies')).some((c: { key: string }) => c.key.startsWith(`recovery/${A1}/`)), "within 30 days of A1's removal no copy of A1 is left anywhere");
			check((await held('live', `deletion/${A1}.json`)) && (await held('copies', `deletion/${A1}.json`)), 'the deletion record outlives the copies it governs, in both buckets');
			check(code(await post(`/recovery/copies/${copies.a1second!.copyId}/stage`, { caseId: A1 }), 409, 'case-deleted') && code(await post(`/recovery/copies/${copies.a2!.copyId}/stage`, { caseId: A2 }), 404, 'no-such-copy'), "a rotated copy can no longer be staged (A2's answers 404 no-such-copy; A1's is refused as deleted first)");
			const fa = await post(`/cases/${A2}/deletion/request`, { actor: { role: 'firm-admin', id: 'fa-1' } });
			check(fa.status === 200, 'a firm admin requests the deletion of A2 and nobody approves it');
			const r3 = await rotate(removedAt + 400 * DAY);
			check(r3.removed.length === 0 && (await json(`/cases/${A2}/deletion`)).state === 'requested', 'at + 400 days rotation removes nothing more, and the unapproved request is still only a request');
			const leftOfA1 = [];
			for (const k of [`import/${stagedA1}.zip`, `orig/${oA1.sha}`, `pkg/${V1}/datasets/chronology.json`, `pkg/${V2}/datasets/chronology.json`, `rm/${V1}/chronology.json`, `rm/${V2}/chronology.json`, `bundle/${A1}/b-1.pdf`]) if (await held('live', k)) leftOfA1.push(`live ${k}`);
			for (const c of Object.values(copies)) if (await held('copies', `recovery/${A1}/${c.copyId}.zip`)) leftOfA1.push(`copies recovery/${A1}/${c.copyId}.zip`);
			check(leftOfA1.length === 0 && (await held('live', `deletion/${A1}.json`)), `at A1's removal + 400 days no object of A1 is left in either bucket, the staged packet of its aborted restore included, except its deletion record (${leftOfA1.join(', ')})`);
			check(orphanHeld && orphanAtR2 && !(await held('live', `import/${orphan}.zip`)), 'a packet uploaded through GRS-109 names no case, so removal cannot find it: it survives rotation while younger than 30 days and ages out with the copies');
			const v = await http(`/cases/${A2}/verify`);
			const o = await http(`/cases/${A2}/originals/${oA2.assetId}`);
			check(v.status === 200 && o.status === 200 && sha256(o.bytes) === oA2.sha && (await http(`/cases/${A2}/documents/S-0001`)).status === 200 && rowsOf(await work(A2)).length === 5, 'no automatic case purge: A2 is live, verified and complete with every row, 400 days on');
			const bundles = (await json(`/cases/${A2}/bundles`)) as unknown[];
			check(bundles.length === 1 && (await held('live', `bundle/${A2}/b-1.pdf`)), "A2's bundle history is kept: rotation ages only recovery copies");
			check((await http('/identity')).status === 200 && (await held('live', `orig/${oShared.sha}`)) && (await held('live', `pkg/${VB}/datasets/chronology.json`)), 'no client purge: the deployment, its identity and its live objects all stay');
			check(code(await post('/recovery/rotate', {}), 400, 'invalid-field') && code(await post('/recovery/rotate', { scheduledTime: 'soon' }), 400, 'invalid-field'), 'rotation with no scheduledTime or a malformed one is refused, naming the field');
			Object.assign(m, { rotations: rotations + 2, copiesRemoved: removed, copiesKept: r3.kept, bundleVersionsKept: bundles.length, packetsAged: orphanHeld && !(await held('live', `import/${orphan}.zip`)) ? 1 : 0 });
		});

		// ----- the objects of a restore that never finished: no row names them, so removal and rotation must find them anyway -----
		await leg('restore-leftovers', ["POST /restore/packets, PUT …/1, POST …/complete, for a synthetic backup of each of two cases with no version", 'POST /restore/packets/<id>/open, …/step (never …/finish), GET /recovery/head/live/<key>', wcmd('r2 object put {recovery-a,recovery-copies-a}/deletion/<A4>.json --local (a valid record, D1 holds no row of A4)'), 'GET /cases/<A4>/documents/<ref>; GET /recovery/head/live/<key>; GET /probe/live/<A4>', 'POST /recovery/rotate {scheduledTime} 30 days - 1 minute and + 1 minute after the steps; GET /recovery/head/live/<key>'], async (check, m) => {
			const A3 = 'case-recovery-a3';
			const A4 = 'case-recovery-a4';
			const leftovers = async (caseId: string, tag: string) => {
				const v = versionOf(`${tag} leftovers`);
				const orig = synthetic(`recovery probe leftover original ${tag}`, 60);
				const file = enc.encode(JSON.stringify({ synthetic: true, tag }));
				const list = enc.encode(JSON.stringify([{ ref: 'S-9001' }]));
				const packet = await upload(backupZip(caseId, v, [{ path: `originals/${sha256(orig)}`, kind: 'original', bytes: orig }, { path: 'package/datasets/leftover.json', kind: 'package', bytes: file }, { path: 'list/chronology.json', kind: 'list', bytes: list }]));
				const run = await restorePacket(packet, caseId, false);
				return { v, run, keys: [`orig/${sha256(orig)}`, `pkg/${v}/datasets/leftover.json`, `rm/${v}/chronology.json`] };
			};
			const held3 = async (keys: string[]) => (await Promise.all(keys.map((k) => held('live', k)))).filter(Boolean).length;
			const a3 = await leftovers(A3, 'A3');
			const a4 = await leftovers(A4, 'A4');
			const shared = `orig/${oShared.sha}`;
			const stepped = await held3([...a3.keys, ...a4.keys]);
			check(a3.run.open === '200' && a3.run.step === '200' && a4.run.open === '200' && a4.run.step === '200' && stepped === 6, `two backups of cases with no version are opened and stepped, never finished: each leaves an original, a package file and a list under orig/, pkg/ and rm/ (${JSON.stringify([a3.run, a4.run])})`);
			check(d1('client-a', `SELECT count(*) AS n FROM results_version WHERE version_id IN ('${a3.v}', '${a4.v}')`)[0]?.n === 0 && (await liveOf(A3)).versions.length === 0 && (await liveOf(A4)).versions.length === 0, 'no D1 row names either version: nothing but the objects shows that a restore began');
			// A4: a record in both buckets removes the case on the next request for it, as in a fresh deployment that never saw the removal
			const stamp = new Date().toISOString();
			const record = { format: 'clearcase.deletion-record/1', client: 'client-a', caseId: A4, requestedBy: 'firm-admin:fa-1', requestedAt: stamp, approvedBy: 'global-admin:ga-1', approvedAt: stamp, offeredExport: { exportId: crypto.randomUUID(), sha256: '0'.repeat(64), size: 1, offeredAt: stamp }, removedBy: 'global-admin:ga-1', removedAt: stamp };
			const file = path.join(scratch, 'leftover-record.json');
			writeFileSync(file, JSON.stringify(record));
			check(r2put('client-a', 'recovery-a', `deletion/${A4}.json`, file).code === 0 && r2put('client-a', 'recovery-copies-a', `deletion/${A4}.json`, file).code === 0, "A4's deletion record is written to both buckets while D1 holds no row of A4");
			const gone = await http(`/cases/${A4}/documents/S-9001`);
			check(code(gone, 410, 'case-deleted'), 'the next request for A4 answers 410 case-deleted: the ledger removed it');
			const remaining4 = (await Promise.all(a4.keys.map(async (k) => ((await held('live', k)) ? k : null)))).filter(Boolean);
			check(remaining4.length === 0, `the original, package file and list that A4's unfinished restore wrote are erased with the case (${remaining4.join(', ')} left)`);
			const res = residue('client-a', A4, [a4.v], []);
			check(res.left.length === 0 && (await held('live', shared)) && (await held3(a3.keys)) === 3, `no row of A4 is left in any of the ${res.tables} tables, the original A2 also records stays, and A3's objects, another case's, are untouched (${res.left.join(', ')})`);
			// A3: nothing removes it; its leftovers age out like the staged packets do
			const steppedAt = Date.now();
			const rotate = async (at: number) => {
				const r = await post('/recovery/rotate', { scheduledTime: new Date(at).toISOString() });
				if (r.status !== 200) throw new Error(`rotate: ${r.status} ${r.text.slice(0, 200)}`);
			};
			await rotate(steppedAt + 30 * DAY - 60_000);
			check((await held3(a3.keys)) === 3, "at 30 days less a minute after the steps rotation removes none of A3's leftovers (rolling)");
			await rotate(steppedAt + 30 * DAY + 60_000);
			const stillThere = (await Promise.all(a3.keys.map(async (k) => ((await held('live', k)) ? k : null)))).filter(Boolean);
			check(stillThere.length === 0, `30 days and a minute after the steps rotation removes A3's leftovers: they name no case a removal could find (${stillThere.join(', ')} left)`);
			const named = [shared, `orig/${oA2.sha}`, `pkg/${VB}/datasets/chronology.json`];
			const kept = (await held3(named)) + (((await http(`/cases/${A2}/originals/${oA2.assetId}`)).status === 200) ? 0 : -1);
			check(kept === named.length, 'rotation leaves what a row names: the original A2 shares with A1, A2’s own original and its package file stay, and A2 serves');
			Object.assign(m, { stepped, erasedByLedger: a4.keys.length - remaining4.length, agedOut: a3.keys.length - stillThere.length, kept, residueRows: res.left.length });
		});

		// ----- a deletion record that is not this client's, or not well formed, stops the deployment -----
		await leg('ledger-guards', [wcmd('r2 object put recovery-copies-a/deletion/<case>.json --local (a record naming client B, then one with no caseId)'), 'GET /recovery/copies after each', wcmd('r2 object delete recovery-copies-a/deletion/<case>.json --local'), 'GET /recovery/copies'], async (check, m) => {
			let refused = 0;
			const plant = (name: string, record: unknown) => {
				const f = path.join(scratch, name);
				writeFileSync(f, JSON.stringify(record));
				if (r2put('client-a', 'recovery-copies-a', 'deletion/case-recovery-planted.json', f).code !== 0) throw new Error('planting a ledger record');
			};
			const base = { format: 'clearcase.deletion-record/1', client: 'client-b', caseId: 'case-recovery-planted', requestedBy: 'firm-admin:x', requestedAt: deleted.removedAt, approvedBy: 'global-admin:x', approvedAt: deleted.removedAt, offeredExport: { exportId: crypto.randomUUID(), sha256: '0'.repeat(64), size: 1 }, removedBy: 'global-admin:x', removedAt: deleted.removedAt };
			plant('foreign.json', base);
			await serve('client-a');
			const foreign = await http('/recovery/copies');
			check(code(foreign, 503, 'foreign-deletion-record') && foreign.json().binding === 'RECOVERY' && !foreign.text.includes('client-b') && (refused++, true), "from the first request of a fresh isolate, a deletion record naming another client answers 503 foreign-deletion-record and is never applied");
			const { caseId: _, ...noCase } = base;
			plant('malformed.json', { ...noCase, client: 'client-a' });
			const malformed = await http(`/cases/${A2}/documents/S-0001`);
			check(code(malformed, 503, 'invalid-deletion-record') && (refused++, true), 'a record with no caseId answers 503 invalid-deletion-record (fail-closed on a missing field)');
			plant('mismatched.json', { ...base, client: 'client-a', caseId: A2 });
			const mismatched = await http(`/cases/${A2}/documents/S-0001`);
			check(code(mismatched, 503, 'invalid-deletion-record') && (refused++, true) && d1('client-a', `SELECT count(*) AS n FROM case_deletion WHERE case_id = '${A2}' AND state = 'removed'`)[0]?.n === 0, "a record stored under another case's key is refused too, and A2 is not erased by it");
			if (wrangler('r2', 'object', 'delete', 'recovery-copies-a/deletion/case-recovery-planted.json', '--local', '--env', 'client-a').code !== 0) throw new Error('removing the planted record');
			check((await http(`/cases/${A2}/documents/S-0001`)).status === 200, 'with the planted record gone the deployment answers again, and A2 is intact');
			m.refusedRequests = refused;
		});

		// ----- a running isolate learns of a deletion that its D1 does not hold -----
		await leg('warm-isolate', ['POST /cases/<A2>/deletion/approve, …/offer {exportId}, GET /cases/<A2>/documents/<ref>', wcmd('r2 object put {recovery-a,recovery-copies-a}/deletion/<A2>.json --local (a valid record, D1 still says offered)'), 'every case route of A2 under the same running Worker', 'POST /cases/<A2>/deletion/remove {actor global-admin}, GET /cases/<A2>/deletion', wcmd('d1 execute DB --local --env client-a --command "<every table with a case_id, version_id or export_id column>"')], async (check, m) => {
			const GA = { role: 'global-admin', id: 'ga-1' };
			const ids = (sql: string, c: string) => (d1('client-a', sql) as Record<string, string>[]).map((r) => r[c]!);
			const exportsOfA2 = ids(`SELECT export_id FROM export_job WHERE case_id = '${A2}'`, 'export_id');
			const versionsOfA2 = ids(`SELECT version_id FROM results_version WHERE case_id = '${A2}'`, 'version_id');
			const approved = await post(`/cases/${A2}/deletion/approve`, { actor: GA });
			const sealed = await exportCase(A2);
			exportsOfA2.push(sealed.exportId);
			const offered = await post(`/cases/${A2}/deletion/offer`, { actor: GA, exportId: sealed.exportId });
			check(approved.status === 200 && offered.status === 200 && (await http(`/cases/${A2}/documents/S-0001`)).status === 200, 'A2 is approved and its export offered, and this running Worker has served A2');
			const d = await json(`/cases/${A2}/deletion`);
			// What another isolate writes before its erasure stops part-way, or what D1 Time Travel leaves behind: the record is in both buckets, D1 says offered.
			const record = { format: 'clearcase.deletion-record/1', client: 'client-a', caseId: A2, requestedBy: d.requested_by, requestedAt: d.requested_at, approvedBy: d.approved_by, approvedAt: d.approved_at, offeredExport: { exportId: d.export_id, sha256: d.export_sha256, size: d.export_size, offeredAt: d.offered_at }, removedBy: 'global-admin:ga-2', removedAt: new Date().toISOString() };
			const file = path.join(scratch, 'warm-record.json');
			writeFileSync(file, JSON.stringify(record));
			check(r2put('client-a', 'recovery-a', `deletion/${A2}.json`, file).code === 0 && r2put('client-a', 'recovery-copies-a', `deletion/${A2}.json`, file).code === 0 && d.state === 'offered', "A2's deletion record is written to both buckets while D1 still says offered");
			let gone = 0;
			const answers: string[] = [];
			for (const [label, request] of caseRoutes(A2)) {
				const r = await request();
				if (code(r, 410, 'case-deleted') && !r.text.includes('SYNTHETIC')) gone++;
				else answers.push(`${label} ${r.status}`);
			}
			check(gone === caseRoutes(A2).length, `the same running Worker answers 410 case-deleted on every case route of A2, reads and writes alike, with no case bytes (${answers.join(', ')})`);
			const retry = await post(`/cases/${A2}/deletion/remove`, { actor: GA });
			check(retry.status === 200 && retry.json().state === 'removed' && retry.json().repeated === true, "the Global Admin's retried removal succeeds as a repeat: the case routes in front of it already brought D1 in line with the record that is in both buckets");
			check((await json(`/cases/${A2}/deletion`)).removed_at === record.removedAt, "D1 holds the record's removal time: the removal adopts the record and writes no new one");
			const res = residue('client-a', A2, versionsOfA2, exportsOfA2);
			check(res.left.length === 0 && isGone(await liveOf(A2)), `A2 holds no row in any of the ${res.tables} tables sqlite_master lists with such a column (${res.left.join(', ')})`);
			Object.assign(m, { routesGone: gone, repeatedRemovals: retry.json().repeated === true ? 1 : 0, residueRows: res.left.length });
		});
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	} finally {
		for (const s of [...live]) await stopServer(s).catch((e: unknown) => (failure ??= String(e)));
		server = null;
	}
	if (!keepState) rmSync(persist, { recursive: true, force: true }), rmSync(scratch, { recursive: true, force: true });

	const endSha = head();
	const clean = !dirty() && !allowDirty;
	const summary: Record<string, unknown> = {
		schema: SCHEMA,
		sourceSha: sha,
		inputs: inputsAt(sha),
		treeClean: clean && endSha === sha,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: process.versions.bun, node: node.version, workerd: pins.workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node.version}`, app: `workerd ${pins.workerd} (native)` },
		pins,
		artifact,
		isolation: { network: isolation, env: Object.keys(env).sort() },
		legs,
		hold: HOLD,
		devProxyRetries: { count: proxyRetries.length, requests: [...proxyRetries] },
		failure,
		evidence: false,
	};
	const draft = { ...summary, evidence: true, checker: { mutationsRefused: 1, accepted: null } };
	if (failure === null && clean && endSha === sha && checkSummary(draft, sha).length === 0) {
		const mm = mutationsRefused(draft, sha);
		summary.checker = { mutationsRefused: mm.refused, accepted: mm.accepted };
		summary.evidence = mm.accepted === null && checkSummary({ ...summary, evidence: true }, sha).length === 0;
		if (mm.accepted !== null) console.log(`FAIL    the checker accepted a mutated summary: ${mm.accepted}`);
	} else if (failure === null) for (const problem of checkSummary(draft, sha).slice(0, 10)) console.log(`shape: ${problem}`);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	for (const name of LEGS) console.log(`${legs[name].status.padEnd(7)} ${name}${legs[name].failure ? `: ${legs[name].failure}` : ''}`);
	if (!clean || endSha !== sha) console.log(`FAIL    tree changed or dirty during the run (HEAD ${endSha.slice(0, 12)}, clean ${clean})`);
	console.log(`${summary.evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} evidence: ${summary.evidence} summary: ${path.relative(root, out)}`);
	return summary.evidence ? 0 : 1;
}

function enterOffline(args: string[]): number {
	const node = realNode();
	const offline = path.join(repo(), 'tests/e2e/pilot/offline.sh');
	const ids = (flag: string) => run('id', [flag], { env: { PATH: '/usr/bin:/bin' } }).out.trim();
	const r = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${ids('-u')}`, `OUTER_GID=${ids('-g')}`, offline, process.execPath, import.meta.filename, '--inside', ...args], { cwd: HERE, stdio: 'inherit', env: { PATH: `${path.dirname(node.path)}:/usr/bin:/bin` } });
	return r.status ?? 1;
}

/** A git command whose failure is an answer, not an error. */
const asked = (...args: string[]) => run('git', args, { env: { PATH: '/usr/bin:/bin' } });

/**
 * What the run reads from the repository: nothing outside these decides its result. This probe's Worker imports the storage
 * Worker (src/), applies its schema.sql, and takes its pins from its package.json and bun.lock; offline.sh is the namespace
 * it runs in. The summary records the git object id of each at sourceSha (the deployment probe's rule, deploy/probes/summary-check.ts).
 */
export const PROBE_INPUTS = ['tests/hosting-probe/recovery', 'tests/hosting-probe/storage/src', 'tests/hosting-probe/storage/schema.sql', 'tests/hosting-probe/storage/package.json', 'tests/hosting-probe/storage/bun.lock', 'tests/e2e/pilot/offline.sh'] as const;
const objectAt = (rev: string, input: string) => {
	const r = asked('rev-parse', `${rev}:${input}`);
	return r.code === 0 ? r.stdout.trim() : null;
};
const inputsAt = (rev: string) => Object.fromEntries(PROBE_INPUTS.map((input) => [input, objectAt(rev, input) ?? 'missing']));

/**
 * Whether the summary vouches for this checkout: `sourceSha` is a commit of it and an ancestor of HEAD, never rewritten to
 * HEAD; the object ids it records are those of the inputs at sourceSha; and those ids are the same at HEAD, so a merge of
 * other tickets' work changes nothing the summary vouches for.
 */
export function bindingProblems(sourceSha: string, recorded: unknown): string[] {
	if (!/^[0-9a-f]{40}$/.test(sourceSha) || asked('cat-file', '-e', `${sourceSha}^{commit}`).code !== 0) return [`sourceSha ${sourceSha.slice(0, 60)} is not a commit of this clone`];
	if (asked('merge-base', '--is-ancestor', sourceSha, 'HEAD').code !== 0) return [`sourceSha ${sourceSha} is not an ancestor of HEAD`];
	const ids = isObject(recorded) ? recorded : {};
	const problems: string[] = [];
	for (const input of PROBE_INPUTS) {
		if (ids[input] === undefined || ids[input] !== objectAt(sourceSha, input)) problems.push(`${input}: the inputs recorded in the summary are not what ${sourceSha.slice(0, 12)} held`);
		else if (objectAt('HEAD', input) !== ids[input]) problems.push(`${input} changed since the run at ${sourceSha.slice(0, 12)}: run the probe again`);
	}
	return problems;
}

/** What `--check` and `test:check` decide for a summary: the sourceSha it names and the inputs it records are bound to this checkout, and its shape holds for that sourceSha. */
export function checkEvidence(summary: unknown): string[] {
	const sha = isObject(summary) && typeof summary.sourceSha === 'string' ? summary.sourceSha : '';
	return [...bindingProblems(sha, isObject(summary) ? summary.inputs : undefined), ...checkSummary(summary, sha)];
}

/** `test:check`: the committed summary passes as it is, and every mutation of it is refused. */
function selfTest(): number {
	const file = path.join(HERE, '../../../docs/acceptance/hosting/evidence/recovery-summary.json');
	const summary = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	const control = checkEvidence(summary);
	for (const problem of control) console.log(`control refused: ${problem}`);
	const named: [string, (s: any) => void][] = [
		['evidence false', (s) => (s.evidence = false)],
		['a leg FAIL', (s) => (s.legs['deletion-reapply'].status = 'FAIL')],
		['a refused restore count lowered', (s) => (s.legs['deletion-reapply'].measured.restoresRefused = 4)],
		['a residue row', (s) => (s.legs['deletion-flow'].measured.residueRows = 1)],
		['an assertion dropped', (s) => s.legs['deletion-flow'].asserted.pop()],
		['a HOLD dropped', (s) => s.hold.pop()],
		['failure set', (s) => (s.failure = 'x')],
		['a made-up sourceSha', (s) => (s.sourceSha = '0'.repeat(40))],
		['an input object id of another tree', (s) => (s.inputs['tests/hosting-probe/storage/src'] = '1'.repeat(40))],
		['an input dropped', (s) => delete s.inputs['tests/e2e/pilot/offline.sh']],
		['an input added', (s) => (s.inputs['README.md'] = '1'.repeat(40))],
	];
	// A real commit from before the last change to the Worker: the code at HEAD is not the code the summary would then describe.
	const worker = asked('log', '-1', '--format=%H', '--', 'src/worker.ts').stdout.trim();
	const before = worker ? asked('rev-parse', `${worker}~1`).stdout.trim() : '';
	if (/^[0-9a-f]{40}$/.test(before)) named.push(['a sourceSha from before the last change to the Worker', (s) => (s.sourceSha = before)]);
	let holes = 0;
	for (const [label, edit] of named) {
		const copy = structuredClone(summary);
		edit(copy);
		if (checkEvidence(copy).length === 0) (holes++, console.log(`HOLE    ${label} passes --check`));
	}
	const mm = mutationsRefused(summary, summary.sourceSha as string);
	if (mm.accepted !== null) console.log(`HOLE    ${mm.accepted} passes --check`);
	const ok = control.length === 0 && holes === 0 && mm.accepted === null && mm.refused > 0;
	console.log(`${ok ? 'SELF-TEST PASS' : 'SELF-TEST FAIL'} control ${control.length === 0 ? 'passes' : 'refused'}; ${named.length} named and ${mm.refused} generated mutations refused${mm.accepted ? `; accepted: ${mm.accepted}` : ''}`);
	return ok ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) {
	const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'string' }, 'self-test': { type: 'boolean' }, inside: { type: 'boolean' }, 'keep-state': { type: 'boolean' }, 'allow-dirty': { type: 'boolean' } } });
	try {
		if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
		if (values['self-test']) process.exit(selfTest());
		if (values.check) {
			const problems = checkEvidence(JSON.parse(readFileSync(values.check, 'utf8')));
			for (const problem of problems) console.log(`refused: ${problem}`);
			console.log(problems.length ? `CHECK FAIL ${values.check}` : `CHECK PASS ${values.check}`);
			process.exit(problems.length ? 1 : 0);
		}
		const out = path.resolve(values.out ?? path.join(repo(), '.local/hosting-probe/recovery/summary.json'));
		if (!values.inside) process.exit(enterOffline(['--out', out, ...(values['keep-state'] ? ['--keep-state'] : []), ...(values['allow-dirty'] ? ['--allow-dirty'] : [])]));
		if (process.env.CLEARCASE_OFFLINE !== '1') throw new Refusal('--inside runs only under tests/e2e/pilot/offline.sh');
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void Promise.allSettled([...live].map(stopServer)).then(() => process.exit(130)));
		process.exit(await main(out, values['keep-state'] === true, values['allow-dirty'] === true));
	} catch (e) {
		if (!(e instanceof Refusal)) throw e;
		console.error(`PROBE REFUSED: ${e.message}`);
		process.exit(2);
	}
}
