// The local workerd legs of the storage proof (GRS-109). From this directory:
//
//   bun install --frozen-lockfile   # once, online: this workspace's own pins, apart from the root lockfile
//   bun run --bun probe [--out FILE] [--scale poc|smoke]
//   bun run --bun probe --check FILE
//
// The first form builds the probe Worker with Bun, provisions per-client local D1 databases and R2 buckets with Wrangler's
// CLI, serves each deployment on native workerd through `wrangler dev --local` (Node hosts Wrangler only; Bun hosts the
// build, this runner and its requests) and runs each leg against it, at the POC scale of generate.ts by default. It runs
// inside tests/e2e/pilot/offline.sh: a network namespace with only loopback up and the host resolver hidden, so no
// Cloudflare account, login or request is possible. Every child gets an explicit environment allowlist. It refuses (exit 2)
// a dirty tree, Bun other than packageManager's, an installed package that is not its pin, or a Node that is really Bun;
// otherwise it writes the summary (default .local/hosting-probe/storage/summary.json) and exits 0 only when `evidence` is
// true: every leg PASS at the POC scale, and HEAD and the tree unchanged at the end. Logs stay in the run directory under
// .local/hosting-probe/storage/; the local D1 and R2 state (several GB at POC scale) is deleted at the end unless
// --keep-state is given.
//
// `--check FILE` refuses (exit 1) a summary that is not this runner's PASS for HEAD: exact key sets, types and values at
// every level (expectedShape), measurements included. check-mutations.ts mutates every leaf of a real PASS summary and runs
// this check on each (bun run --bun test:check).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type OriginalPlan, type Plan, type Scale, V5, aggregates, listText, originalBytes, packageFileText, plan, readModel } from './generate.ts';

const HERE = import.meta.dirname;
const SCHEMA = 'clearcase.storage-probe/1';
const LEGS = ['build', 'provision', 'crossed-bindings', 'upload', 'import', 'layout', 'range', 'write-once', 'two-pass', 'user-work', 'export', 'corruption', 'restore'] as const;
type LegName = (typeof LEGS)[number];
type Measure = Record<string, number | string | boolean>;
type Leg = { status: 'PASS' | 'FAIL' | 'NOT RUN'; commands: string[]; asserted: string[]; measured: Measure; failure?: string };
const PORT = 18797;
const BASE = `http://127.0.0.1:${PORT}`;
const SEED = 'grs-109';
const MiB = 1024 * 1024;
/** The cloud legs: each needs moment M2 (Workers Paid plus R2, EU jurisdiction) and Dian's unpin. */
const HOLD = [
	'P1 page latency from South Africa and the cold-isolate fraction: needs real Workers, D1 and R2 (M2)',
	'P2 presigned-PUT upload burst of ~1,700 objects: needs the R2 S3 endpoint (M2)',
	'P3 verification-job CPU against the Workers CPU limit, and whether a presigned PUT can enforce a SHA-256: needs real Workers and R2 (M2)',
	'P5 enforcement of the per-invocation D1 query and subrequest limits: local workerd does not enforce them (M2)',
	'P6 D1 Time Travel restore and undo, and wrangler d1 export duration: need a real D1 database (M2)',
	'actual EU placement of D1 and R2 (jurisdiction eu): needs a Cloudflare account (M2)',
];

class Refusal extends Error {}

const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
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
/** SHA-256 of a file in 8 MiB reads, so a multi-GB blob never has to fit in one Buffer. */
function fileSha(file: string): string {
	const h = createHash('sha256');
	const fd = openSync(file, 'r');
	const buf = Buffer.alloc(8 << 20);
	for (let at = 0, n = 1; n > 0; at += n) h.update(buf.subarray(0, (n = readSync(fd, buf, 0, buf.length, at))));
	closeSync(fd);
	return h.digest('hex');
}

/** [commands, asserted] each leg writes; a leg that gains or loses one changes this table, or `evidence` stays false. */
const LEG_SHAPE: Record<LegName, [number, number]> = {
	build: [1, 3],
	provision: [6, 4],
	'crossed-bindings': [7, 9],
	upload: [4, 6],
	import: [9, 12],
	layout: [5, 9],
	range: [10, 11],
	'write-once': [5, 7],
	'two-pass': [5, 5],
	'user-work': [12, 16],
	export: [6, 8],
	corruption: [11, 12],
	restore: [8, 8],
};

type Spec = null | boolean | number | string | RegExp | ((v: unknown) => boolean) | Spec[] | { [key: string]: Spec };
const NONEMPTY = (v: unknown) => typeof v === 'string' && v.length > 0;
const COUNT = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const POSITIVE = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const MS = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0; // a measured wall time; zero would hide a zeroed field
/** The requests Wrangler's dev proxy dropped before they reached the Worker, each retried: the count must equal the list. */
const RETRIES = (v: unknown) => isObject(v) && Object.keys(v).sort().join() === 'count,requests' && Array.isArray(v.requests) && v.requests.every(NONEMPTY) && v.count === v.requests.length;
const SHA = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const pocPlan = plan(SEED, 'poc');
const poc = aggregates(pocPlan);
const POC_MULTIPART = pocPlan.originals.filter((o) => o.size > 64 * MiB).length;
/** What each leg measures, and what each value must be. Counts the plan fixes are literals; timings are local only. */
const MEASURES: Record<LegName, Record<string, Spec>> = {
	build: { workerBytes: POSITIVE },
	provision: { deployments: 3, schemaStatements: POSITIVE },
	'crossed-bindings': { refusedRequests: 9 },
	upload: { originals: poc.originals.count, bytes: poc.originals.bytes, multipart: POC_MULTIPART, singlePuts: poc.originals.count - POC_MULTIPART, failures: 0, retries: 0, wallMs: MS, verifiedAtFinalizeBytes: poc.originals.bytes, maxR2OpsPerFinalize: 2 },
	import: {
		documents: poc.documents.rows,
		assets: poc.assets.rows,
		seeds: poc.seeds.rows,
		packageFiles: poc.package.files,
		packageBytes: poc.package.bytes,
		listBytes: poc.list.bytes,
		jsonStatements: POSITIVE,
		boundStatements: POSITIVE,
		maxStatementsPerInvocation: POSITIVE,
		rowsWritten: POSITIVE,
		recoveredRows: POSITIVE,
		wallMs: MS,
	},
	layout: {
		d1BytesPerVersion: POSITIVE,
		d1BytesWithPackageBlobs: POSITIVE,
		largestPackageValue: 1_827_097,
		localRefusesValueOver2MB: false,
		localRefuses101Parameters: true,
		documentPageD1Statements: 1,
		documentPageR2Ops: 0,
		chronologyD1Statements: 1,
		chronologyR2Ops: 1,
		originalRangeD1Statements: 1,
		originalRangeR2Ops: 1,
		coldDocumentMs: MS,
		warmDocumentMs: MS,
		coldChronologyMs: MS,
		warmChronologyMs: MS,
	},
	range: { largestOriginalBytes: poc.originals.max, rangeOnLargestMs: MS, wholeLargestMs: MS, workerdPeakRssBytes: POSITIVE },
	'write-once': { refusedWrites: 4 },
	'two-pass': { originalBytes: 40 * MiB, changedReadsRefused: 3 },
	'user-work': { concurrentAdds: 100, duplicateSeqs: 0, naiveDuplicateSeqs: POSITIVE, racedReplaces: 20, staleReplaces: 19, restoreRace: /^(restore-first|adds-first|interleaved)$/ },
	export: { entries: POSITIVE, packetBytes: POSITIVE, parts: POSITIVE, steps: POSITIVE, maxR2OpsPerStep: POSITIVE, maxD1StatementsPerStep: POSITIVE, wallMs: MS, offlineCheckMs: MS, workerdPeakRssBytes: POSITIVE },
	corruption: { casesRefused: 8 },
	restore: { entries: POSITIVE, steps: POSITIVE, wallMs: MS, objects: POSITIVE },
};

/** The one expected shape of a PASS summary for `sha`: every field, its type and its value. */
function expectedShape(sha: string, summary: Record<string, unknown>): Spec {
	const node = isObject(summary.hosts) && typeof summary.hosts.node === 'string' ? summary.hosts.node : '';
	const workerd = pkg.devDependencies.workerd!;
	const retried = isObject(summary.devProxyRetries) && Array.isArray(summary.devProxyRetries.requests) ? summary.devProxyRetries.requests : null;
	const uploadRetries = retried ? retried.filter((r) => typeof r === 'string' && r.startsWith('upload: ')).length : -1;
	return {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: true,
		scale: 'poc',
		seed: SEED,
		startedAt: ISO,
		finishedAt: ISO,
		runDir: /^\.local\/hosting-probe\/storage\/[0-9A-Za-z-]+$/,
		hosts: { bun: BUN, node: /^\d+\.\d+\.\d+$/, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node}`, app: `workerd ${workerd} (native)` },
		pins: { ...pkg.devDependencies },
		artifact: /^sha256:[0-9a-f]{64}$/,
		isolation: { network: /^own network namespace: interfaces \[lo\], 0 IPv4 routes, 0 IPv6 routes; /, env: ENV_KEYS },
		corpus: { target: v5Target(), generated: poc },
		legs: Object.fromEntries(LEGS.map((name) => [name, { status: 'PASS', commands: Array.from({ length: LEG_SHAPE[name][0] }, () => NONEMPTY), asserted: Array.from({ length: LEG_SHAPE[name][1] }, () => NONEMPTY), measured: name === 'upload' ? { ...MEASURES.upload, retries: uploadRetries } : MEASURES[name] }])),
		hold: HOLD,
		devProxyRetries: RETRIES,
		failure: null,
		evidence: true,
		checker: { mutationsRefused: POSITIVE, accepted: null },
	};
}
const v5Target = () => JSON.parse(JSON.stringify(V5)) as Spec;
const ENV_KEYS = ['CI', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'HOME', 'PATH', 'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_SEND_METRICS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];

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

/** Every leaf and container of the summary, deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown key added to each object. */
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
	for (const [name, pin] of Object.entries(pkg.devDependencies)) {
		const file = path.join(HERE, 'node_modules', name, 'package.json');
		const installed = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version : 'missing';
		if (installed !== pin) wrong.push(`${name} ${installed} (pin ${pin})`);
	}
	if (wrong.length) throw new Refusal(`installed packages differ from the pins: ${wrong.join(', ')}; run bun install --frozen-lockfile here`);
	return { ...pkg.devDependencies };
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
	const all = processes();
	const ids = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of all.values()) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
	}
	return [...ids].map((id) => all.get(id)).filter((p): p is Proc => p !== undefined);
}
/** The peak resident set of the server's workerd processes (VmHWM), in bytes: process memory, not an isolate figure. */
function workerdPeak(server: Server): number {
	let peak = 0;
	for (const p of descendants(server.child.pid!).filter((x) => x.exe === 'workerd')) {
		try {
			const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${p.pid}/status`, 'utf8'));
			if (m) peak = Math.max(peak, Number(m[1]) * 1024);
		} catch {}
	}
	return peak;
}

type Server = { child: ChildProcess; tree: Proc[]; label: string };
const live = new Set<Server>();

async function stopServer(server: Server): Promise<'SIGINT' | 'SIGTERM' | 'SIGKILL' | null> {
	const { child } = server;
	const pgid = child.pid!;
	const left = () => [...processes().values()].filter((p) => p.pgrp === pgid || server.tree.some((t) => t.pid === p.pid && t.exe === p.exe));
	const gone = () => (child.exitCode !== null || child.signalCode !== null) && left().length === 0;
	let ended: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | null = null;
	for (const [signal, ms] of [['SIGINT', 12_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (gone()) break;
		ended = signal;
		try {
			process.kill(-pgid, signal);
		} catch {}
		for (const until = Date.now() + ms; Date.now() < until && !gone(); ) await new Promise((r) => setTimeout(r, 100));
	}
	live.delete(server);
	const survivors = left();
	if (survivors.length) throw new Error(`${server.label}: processes survived the stop: ${survivors.map((p) => `${p.pid} ${p.exe}`).join(', ')}`);
	return ended;
}

type Res = { status: number; type: string; headers: Headers; bytes: Uint8Array; json: () => any };
const DROPPED = new TextEncoder().encode('Error: Network connection lost.');
/** Requests Wrangler's dev proxy dropped on its pooled connection to the Worker, before the Worker ran; each was retried. */
const proxyRetries: string[] = [];
let currentLeg = 'setup';
async function http(pathname: string, init: RequestInit & { timeout?: number } = {}): Promise<Res> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(BASE + pathname, { redirect: 'manual', ...init, signal: AbortSignal.timeout(init.timeout ?? 120_000) });
		const bytes = new Uint8Array(await res.arrayBuffer());
		const type = res.headers.get('content-type') ?? '';
		// Wrangler's ProxyWorker answers a dropped connection to the user Worker with a 500 and a text stack, and retries it
		// itself only for GET and HEAD. Every answer of the Worker itself is JSON or verified bytes, so this one is not.
		const dropped = res.status === 500 && !type.startsWith('application/json') && equal(bytes.subarray(0, DROPPED.length), DROPPED);
		if (dropped && attempt <= 2) {
			proxyRetries.push(`${currentLeg}: ${init.method ?? 'GET'} ${pathname.replace(/[0-9a-f]{64}/g, '<sha256>').replace(/[0-9a-f-]{36}/g, '<id>')} (attempt ${attempt + 1})`);
			await new Promise((r) => setTimeout(r, 250));
			continue;
		}
		return { status: res.status, type, headers: res.headers, bytes, json: () => JSON.parse(new TextDecoder().decode(bytes)) };
	}
}
const post = (p: string, b: unknown, timeout?: number) => http(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), timeout });
const probeCount = (r: Res, name: string) => Number(r.headers.get(`x-probe-${name}`));
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

async function main(out: string, scale: Scale, keepState: boolean, allowDirty: boolean): Promise<number> {
	const root = repo();
	const sha = head();
	if (dirty() && !allowDirty) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
	rmSync(out, { force: true });
	const runDir = path.join(root, '.local', 'hosting-probe', 'storage', new Date().toISOString().replace(/[:.]/g, '-'));
	const rel = (p: string) => p.replace(runDir, '<run>');
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
	let cli = 0;
	const wrangler = (...args: string[]) => {
		const r = run(node.path, ['node_modules/wrangler/bin/wrangler.js', ...args, '--persist-to', persist], { env });
		writeFileSync(path.join(logs, `cli-${String(++cli).padStart(3, '0')}-${args.slice(0, 3).join('-').replace(/[^A-Za-z0-9-]/g, '_')}.log`), `${args.join(' ')}\n${r.out}`);
		return r;
	};
	const wcmd = (...args: string[]) => `node node_modules/wrangler/bin/wrangler.js ${args.join(' ')} --persist-to <run>/persist`;
	const d1 = (envName: string, sqlText: string) => {
		const r = wrangler('d1', 'execute', 'DB', '--local', '--env', envName, '--json', '--command', sqlText);
		if (r.code !== 0) throw new Error(`wrangler d1 execute --env ${envName} failed: ${r.out.slice(-400)}`);
		return (JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as { results: Record<string, unknown>[] }[])[0]!.results;
	};
	const r2put = (envName: string, bucket: string, key: string, file: string) => wrangler('r2', 'object', 'put', `${bucket}/${key}`, '--local', '--env', envName, '--file', file);

	const legs = Object.fromEntries(LEGS.map((n) => [n, { status: 'NOT RUN', commands: [], asserted: [], measured: {} } as Leg])) as Record<LegName, Leg>;
	const startedAt = new Date().toISOString();
	let artifact: string | null = null;
	let server: Server | null = null;
	const serve = async (envName: string) => {
		if (server) await stopServer(server);
		const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--env', envName, '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false'];
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
			child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${envName}: Wrangler exited ${code} before Ready: ${text.slice(-1500)}`))));
		});
		s.tree = descendants(child.pid!);
		if (!s.tree.some((p) => p.exe === 'workerd')) throw new Error(`${envName}: no native workerd under Wrangler`);
		server = s;
		return s;
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

	/** Flips one byte of the local R2 blob that has this size (and SHA-256, when given), as a credential holder with disk access could. */
	const flip = (bucket: string, sizeOf: number, digest: string | null, at: number) => {
		const dir = path.join(persist, 'v3/r2', bucket, 'blobs');
		let flipped = 0;
		for (const f of readdirSync(dir)) {
			const file = path.join(dir, f);
			if (statSync(file).size !== sizeOf || (digest !== null && fileSha(file) !== digest)) continue;
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

	/** Reads a streamed response to its end, or to the error that cut it short: how many bytes arrived and how it ended. */
	const drain = async (res: Response) => {
		let received = 0;
		let error: string | null = null;
		const hash = createHash('sha256');
		try {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) (hash.update(chunk), (received += chunk.length));
		} catch (e) {
			error = String(e);
		}
		return { received, error, sha256: hash.digest('hex') };
	};

	const p: Plan = plan(SEED, scale);
	const shas: string[] = [];
	const bytesOf = (o: OriginalPlan) => originalBytes(p, o);
	const caseId = p.caseId;
	let failure: string | null = null;
	try {
		await leg('build', ['bun run --bun build'], async (check, m) => {
			rmSync(path.join(HERE, 'dist'), { recursive: true, force: true });
			const r = run(process.execPath, ['run', '--bun', 'build'], { env: { PATH: env.PATH!, HOME: env.HOME! } });
			writeFileSync(path.join(logs, 'build.log'), r.out);
			check(r.code === 0, `bun build of src/worker.ts exits 0 offline under Bun ${process.versions.bun}`);
			const worker = path.join(HERE, 'dist/worker.js');
			check(existsSync(worker), 'the Worker module dist/worker.js exists');
			const bytes = readFileSync(worker);
			check(!/node:|bun:|require\(/.test(bytes.toString('utf8')), 'the bundle imports no node:, bun: or CommonJS module');
			artifact = `sha256:${sha256(bytes)}`;
			m.workerBytes = bytes.length;
		});

		const identityFile = (client: string) => {
			const f = path.join(scratch, `identity-${client}.json`);
			writeFileSync(f, JSON.stringify({ client_id: client }));
			return f;
		};
		const statements = readFileSync(path.join(HERE, 'schema.sql'), 'utf8').split(';').filter((s) => s.replace(/--.*$/gm, '').trim()).length;
		await leg('provision', [wcmd('d1 execute DB --local --env client-a --file schema.sql'), wcmd('d1 execute DB --local --env client-b --file schema.sql'), wcmd('d1 execute DB --local --env restore-a --file schema.sql'), wcmd('d1 execute DB --local --env client-{a,b} --command "INSERT INTO storage_identity …"'), wcmd('r2 object put storage-{a,b}/identity/client.json --local'), 'the restore-a identity follows in crossed-bindings'], async (check, m) => {
			for (const e of ['client-a', 'client-b', 'restore-a']) {
				const r = wrangler('d1', 'execute', 'DB', '--local', '--env', e, '--file', 'schema.sql');
				if (r.code !== 0) throw new Error(`schema for ${e}: ${r.out.slice(-400)}`);
			}
			check(true, 'schema.sql applies to the three deployments’ local D1 databases in its own process');
			for (const [e, client] of [['client-a', 'client-a'], ['client-b', 'client-b']] as const) {
				d1(e, `INSERT INTO storage_identity (singleton, client_id, layout) VALUES (1, '${client}', 'one-database-per-client/1')`);
				if (r2put(e, `storage-${client.slice(-1)}`, 'identity/client.json', identityFile(client)).code !== 0) throw new Error(`identity object for ${client}`);
			}
			check(d1('client-a', 'SELECT client_id FROM storage_identity')[0]?.client_id === 'client-a', "client A's database holds client A's identity row");
			check(d1('client-b', 'SELECT client_id FROM storage_identity')[0]?.client_id === 'client-b', "client B's database holds client B's identity row, apart from A's");
			check(d1('restore-a', "SELECT count(*) AS n FROM sqlite_master WHERE name = 'storage_identity'")[0]?.n === 1 && d1('restore-a', 'SELECT count(*) AS n FROM storage_identity')[0]?.n === 0, 'the restore deployment has the schema and no identity yet');
			m.deployments = 3;
			m.schemaStatements = statements;
		});

		// B gets a little user work, so a crossed Worker has something of B's to leak or change.
		await serve('client-b');
		const bAdd = await post('/cases/case-b1/registers/notes/add', { fields: { text: 'synthetic B note' }, operationId: 'b-op-1' });
		if (bAdd.status !== 200) throw new Error(`client B setup: ${bAdd.status}`);
		const bBefore = sha256((await http('/cases/case-b1/work')).bytes);
		const probeOriginal = new TextEncoder().encode('SYNTHETIC ONLY: crossed-binding probe original\n'.repeat(4));
		const probeSha = sha256(probeOriginal);

		await leg('crossed-bindings', [serveCmd('crossed-d1'), 'GET /identity, GET /cases/case-b1/work, PUT /originals/<sha>, POST /cases/case-b1/registers/notes/add', serveCmd('crossed-r2'), 'GET /identity, GET /cases/case-b1/work, PUT /originals/<sha>', serveCmd('restore-a'), 'GET /identity before and after the D1 identity row', serveCmd('client-b')], async (check, m) => {
			let refused = 0;
			const expectRefused = async (r: Promise<Res>, code: string, binding: string) => {
				const res = await r;
				const b = res.json();
				const ok = res.status === 503 && b.code === code && b.binding === binding && !new TextDecoder().decode(res.bytes).includes('client-b') && !new TextDecoder().decode(res.bytes).includes('synthetic B note');
				if (ok) refused++;
				return ok;
			};
			await serve('crossed-d1');
			check(await expectRefused(http('/identity'), 'crossed-binding', 'DB'), "client A's Worker bound to B's database answers 503 crossed-binding naming DB, and never names client B");
			check(await expectRefused(http('/cases/case-b1/work'), 'crossed-binding', 'DB'), "B's user work is not served through the crossed database");
			check(await expectRefused(http(`/originals/${probeSha}`, { method: 'PUT', body: probeOriginal }), 'crossed-binding', 'DB'), 'an upload through the crossed Worker is refused before any write');
			check(await expectRefused(post('/cases/case-b1/registers/notes/add', { fields: { text: 'crossed write' }, operationId: 'x-op' }), 'crossed-binding', 'DB'), 'a user-work write through the crossed Worker is refused');
			await serve('crossed-r2');
			check((await expectRefused(http('/identity'), 'crossed-binding', 'BUCKET')) && (await expectRefused(http('/cases/case-b1/work'), 'crossed-binding', 'BUCKET')) && (await expectRefused(http(`/originals/${probeSha}`, { method: 'PUT', body: probeOriginal }), 'crossed-binding', 'BUCKET')), "client A's Worker bound to B's bucket answers 503 crossed-binding naming BUCKET on reads and writes");
			await serve('restore-a');
			check(await expectRefused(http('/identity'), 'missing-identity', 'DB'), 'a deployment whose database has no identity row answers 503 missing-identity (fail-closed on a missing field)');
			d1('restore-a', "INSERT INTO storage_identity (singleton, client_id, layout) VALUES (1, 'client-a', 'one-database-per-client/1')");
			check(await expectRefused(http('/identity'), 'missing-identity', 'BUCKET'), 'with the D1 identity but no R2 identity object it still answers 503 missing-identity, naming BUCKET');
			if (r2put('restore-a', 'storage-a-restore', 'identity/client.json', identityFile('client-a')).code !== 0) throw new Error('restore-a identity object');
			await serve('client-b');
			check(sha256((await http('/cases/case-b1/work')).bytes) === bBefore, "client B's user work is byte for byte what it was before the crossed requests");
			const leaked = wrangler('r2', 'object', 'get', `storage-a/orig/${probeSha}`, '--local', '--env', 'client-a', '--pipe');
			const leakedB = wrangler('r2', 'object', 'get', `storage-b/orig/${probeSha}`, '--local', '--env', 'client-b', '--pipe');
			check(leaked.code !== 0 && leakedB.code !== 0, 'neither bucket holds the object the crossed Workers were asked to store');
			m.refusedRequests = refused;
		});

		// ----- upload: POC-scale originals through the Worker, finalized and verified -----
		await serve('client-a');
		await leg('upload', ['PUT /originals/<sha256> (single PUT, at most 64 MiB) for each original', 'POST /originals/<sha256>/uploads, PUT …/<part> (64 MiB parts), POST …/complete for the larger ones', 'POST /cases/case-synthetic-1/originals (finalize: the stored bytes hashed whole)', 'PUT with a wrong SHA-256; finalize of an object never uploaded; a repeated PUT'], async (check, m) => {
			const t0 = performance.now();
			let multipart = 0;
			let singles = 0;
			let maxR2 = 0;
			let verified = 0;
			const failures: string[] = [];
			const one = async (o: OriginalPlan) => {
				const bytes = bytesOf(o);
				const h = sha256(bytes);
				shas[o.index] = h;
				if (o.size <= 64 * MiB) {
					const r = await http(`/originals/${h}`, { method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>, timeout: 600_000 });
					if (r.status !== 200) failures.push(`${o.assetId}: PUT ${r.status}`);
					singles++;
				} else {
					const u = await post(`/originals/${h}/uploads`, {});
					const { uploadId } = u.json() as { uploadId: string };
					const parts = [];
					for (let i = 0, n = 1; i < bytes.length; i += 64 * MiB, n++) {
						const r = await http(`/originals/${h}/uploads/${uploadId}/${n}`, { method: 'PUT', body: bytes.subarray(i, i + 64 * MiB) as Uint8Array<ArrayBuffer>, timeout: 600_000 });
						if (r.status !== 200) failures.push(`${o.assetId}: part ${n} ${r.status}`);
						parts.push(r.json());
					}
					const c = await post(`/originals/${h}/uploads/${uploadId}/complete`, { parts });
					if (c.status !== 200 || c.json().size !== o.size) failures.push(`${o.assetId}: complete ${c.status}`);
					multipart++;
				}
				const f = await post(`/cases/${caseId}/originals`, { assetId: o.assetId, sha256: h, size: o.size, filename: o.filename, mediaType: o.mediaType }, 600_000);
				if (f.status !== 200) failures.push(`${o.assetId}: finalize ${f.status} ${new TextDecoder().decode(f.bytes).slice(0, 200)}`);
				else verified += f.json().verifiedBytes as number;
				maxR2 = Math.max(maxR2, probeCount(f, 'r2-ops'));
			};
			// Big originals first, at most two at a time (memory); the rest six at a time.
			const queue = [...p.originals].sort((a, b) => b.size - a.size);
			const workers = (n: number, items: OriginalPlan[]) => Promise.all(Array.from({ length: n }, async () => { for (let o = items.shift(); o; o = items.shift()) await one(o); }));
			await workers(2, queue.filter((o) => o.size > 32 * MiB));
			await workers(6, queue.filter((o) => o.size <= 32 * MiB));
			m.wallMs = ms(t0);
			check(failures.length === 0, `every original uploads and finalizes (${failures.slice(0, 3).join('; ')})`);
			check(verified === p.originals.reduce((n, o) => n + o.size, 0), 'finalize hashed every stored original whole before recording it');
			const wrong = await http(`/originals/${'0'.repeat(64)}`, { method: 'PUT', body: new TextEncoder().encode('SYNTHETIC ONLY: wrong digest\n') });
			check(wrong.status === 422 && wrong.json().code === 'digest-mismatch', "a PUT whose bytes differ from its SHA-256 answers 422 digest-mismatch: R2's put({sha256}) refused it");
			const never = await post(`/cases/${caseId}/originals`, { assetId: 'orig-never', sha256: 'f'.repeat(64), size: 10, filename: 'never.pdf', mediaType: 'application/pdf' });
			check(never.status === 409 && never.json().code === 'not-uploaded', 'finalize of an object that was never uploaded answers 409 not-uploaded');
			const first = p.originals.find((o) => o.size <= 64 * MiB)!;
			const again = await http(`/originals/${shas[first.index]}`, { method: 'PUT', body: bytesOf(first) as Uint8Array<ArrayBuffer> });
			check(again.status === 200 && again.json().repeated === true, 'a repeated PUT of the same content is a no-op (content-addressed, write-once)');
			const missingField = await post(`/cases/${caseId}/originals`, { assetId: first.assetId, sha256: shas[first.index], filename: first.filename, mediaType: first.mediaType });
			check(missingField.status === 400 && missingField.json().field === 'size', `finalize without a size answers 400 naming the field, never a default (${missingField.status} ${new TextDecoder().decode(missingField.bytes).slice(0, 200)})`);
			Object.assign(m, { originals: p.originals.length, bytes: p.originals.reduce((n, o) => n + o.size, 0), multipart, singlePuts: singles, failures: failures.length, retries: proxyRetries.filter((r) => r.startsWith('upload: ')).length, verifiedAtFinalizeBytes: verified, maxR2OpsPerFinalize: maxR2 });
		});

		// ----- import (P5): staging, an interrupted attempt, recovery, the guarded flip, activation -----
		const files = p.packageFiles.map((f) => ({ ...f, text: packageFileText(f) })).map((f) => ({ ...f, sha256: sha256(f.text) }));
		const list = listText(p);
		const model = readModel(p, (i) => shas[i]!);
		const V = `sha256:${sha256(JSON.stringify(files.map((f) => [f.path, f.sha256])))}`;
		const V2 = `sha256:${sha256(`bound arm of ${V}`)}`;
		const expected = { documents: model.documents.length, assets: model.assets.length, seeds: model.seeds.length, files: files.length };
		const beginBody = { expected, list: { sha256: sha256(list), size: Buffer.byteLength(list) } };
		let maxStatements = 0;
		const d1Sizes: number[] = [];
		const d1Size = async () => d1Sizes.push((await http('/d1-size')).json().bytes as number);
		let rowsWritten = 0;
		const sendRows = async (v: string, table: 'document' | 'asset' | 'seed', items: object[], strategy: 'json' | 'bound', fail = false) => {
			let statements = 0;
			const chunk = strategy === 'json' ? 2000 : table === 'asset' ? 900 : 1485; // bound: at most 45 statements an invocation
			for (let i = 0; i < items.length; i += chunk) {
				const r = await post(`/cases/${caseId}/versions/${v}/rows`, { table, strategy, rows: items.slice(i, i + chunk), fail });
				if (fail) return r;
				if (r.status !== 200) throw new Error(`rows ${table} ${strategy}: ${r.status} ${new TextDecoder().decode(r.bytes).slice(0, 300)}`);
				statements += r.json().statements as number;
				maxStatements = Math.max(maxStatements, probeCount(r, 'd1-statements'));
				rowsWritten += probeCount(r, 'd1-rows-written');
			}
			return statements;
		};
		const putFiles = async (v: string) => {
			for (const f of files) {
				const r = await http(`/cases/${caseId}/versions/${v}/files/${f.path}`, { method: 'PUT', headers: { 'x-sha256': f.sha256 }, body: f.text });
				if (r.status !== 200) throw new Error(`file ${f.path}: ${r.status} ${new TextDecoder().decode(r.bytes)}`);
			}
			const l = await http(`/cases/${caseId}/versions/${v}/list`, { method: 'PUT', body: list });
			if (l.status !== 200) throw new Error(`list: ${l.status}`);
		};
		await leg('import', ['POST /cases/<case>/versions/<v>/begin', 'PUT …/files/<path> (37 package files) and PUT …/list', 'POST …/rows (documents, then half the assets): attempt 1 stops there', 'POST …/begin again (recovery)', 'POST …/rows (json_each strategy, every table)', 'POST …/rows with an injected failing statement', 'POST …/finish (before and after the rows are complete)', 'POST …/rows and …/begin for a second version with bound parameters (the bound-row arm)', 'POST /cases/<case>/activate'], async (check, m) => {
			const t0 = performance.now();
			await d1Size();
			check((await post(`/cases/${caseId}/versions/${V}/begin`, beginBody)).json().attempt === 1, 'begin stages a new version (attempt 1)');
			await putFiles(V);
			await sendRows(V, 'document', model.documents, 'json');
			await sendRows(V, 'asset', model.assets.slice(0, Math.floor(model.assets.length / 2)), 'json');
			const early = await post(`/cases/${caseId}/versions/${V}/finish`, {});
			check(early.status === 409 && early.json().code === 'incomplete' && early.json().have.state === 'staging', 'finish before every row is staged answers 409 incomplete and the version stays staging');
			// attempt 1 is abandoned here, as a crashed import would be
			const again = await post(`/cases/${caseId}/versions/${V}/begin`, beginBody);
			const rec = again.json();
			check(again.status === 200 && rec.attempt === 2 && rec.recovered.documents === expected.documents && rec.recovered.assets === Math.floor(expected.assets / 2) && rec.recovered.files === expected.files, 'begin after the interrupted attempt deletes its staged rows in one batch (attempt 2)');
			m.recoveredRows = rec.recovered.documents + rec.recovered.assets + rec.recovered.seeds + rec.recovered.files;
			await putFiles(V);
			const jsonStatements = ((await sendRows(V, 'document', model.documents, 'json')) as number) + ((await sendRows(V, 'asset', model.assets, 'json')) as number) + ((await sendRows(V, 'seed', model.seeds, 'json')) as number);
			const counted = (t: string) => Number(d1('client-a', `SELECT count(*) AS n FROM ${t} WHERE version_id = '${V}'`)[0]!.n);
			const injected = await sendRows(V, 'seed', [{ seed_id: 'seed-injected', row_json: '{}' }], 'json', true);
			check(typeof injected !== 'number' && injected.status === 409 && injected.json().code === 'injected-failure' && counted('seed') === expected.seeds, 'a rows batch whose last statement fails rolls back whole: no injected row stays');
			const done = await post(`/cases/${caseId}/versions/${V}/finish`, {});
			await d1Size();
			check(done.status === 200 && done.json().stored === true, 'finish flips the version to stored once every count matches, in one guarded batch');
			check(counted('document') === expected.documents && counted('asset') === expected.assets && counted('seed') === expected.seeds && counted('package_file') === expected.files, 'D1 holds exactly the expected rows of each table for the version, none duplicated by the retry');
			const late = await sendRows(V, 'seed', [{ seed_id: 'seed-late', row_json: '{}' }], 'json', false).catch((e: Error) => e.message);
			check(typeof late === 'string' && late.includes('409') && counted('seed') === expected.seeds, 'rows sent after the version is stored are refused (409 not-staging)');
			check((await post(`/cases/${caseId}/versions/${V}/begin`, beginBody)).status === 409, 'begin on a stored version answers 409: a stored version is immutable');
			const act = await post(`/cases/${caseId}/activate`, { version: V, expected: null });
			check(act.status === 200, 'activation is one guarded batch: the stored version becomes the active one');
			check((await post(`/cases/${caseId}/activate`, { version: V, expected: null })).status === 409, 'a second activation with a stale expected pointer answers 409');
			// The bound-row arm: the same rows as bound parameters, for the statement count; the version stays a candidate.
			check((await post(`/cases/${caseId}/versions/${V2}/begin`, beginBody)).status === 200, 'a second version (the bound-row arm) stages beside the active one');
			await putFiles(V2);
			const boundStatements = ((await sendRows(V2, 'document', model.documents, 'bound')) as number) + ((await sendRows(V2, 'asset', model.assets, 'bound')) as number) + ((await sendRows(V2, 'seed', model.seeds, 'bound')) as number);
			check((await post(`/cases/${caseId}/versions/${V2}/finish`, {})).status === 200, 'the bound-row arm stores the same rows (a stored candidate, never activated)');
			await d1Size();
			m.wallMs = ms(t0);
			Object.assign(m, { documents: expected.documents, assets: expected.assets, seeds: expected.seeds, packageFiles: files.length, packageBytes: files.reduce((n, f) => n + f.size, 0), listBytes: Buffer.byteLength(list), jsonStatements, boundStatements, maxStatementsPerInvocation: maxStatements, rowsWritten });
		});

		// ----- layout: measured counts for the choices -----
		await leg('layout', ['POST /cases/<case>/versions/<v>/blob-arm (the package as D1 BLOBs, then removed)', 'GET /cases/<case>/documents/<ref> (cold, then 5 warm)', 'GET /cases/<case>/chronology (cold, then 5 warm)', 'GET /cases/<case>/originals/<asset> Range: bytes=0-63', `GET /cases/<case>/versions/<candidate>/files/manifest.json`], async (check, m) => {
			const arm = await post(`/cases/${caseId}/versions/${V}/blob-arm`, {});
			const a = arm.json();
			check(arm.status === 200 && a.files === files.length, 'the 37 package files are written to D1 as BLOBs (layout arm) and removed again');
			m.d1BytesPerVersion = d1Sizes[2]! - d1Sizes[1]!; // the bound arm: one more stored version, its package in R2
			m.d1BytesWithPackageBlobs = a.d1BytesAfter - a.d1BytesBefore;
			m.largestPackageValue = a.largestValue;
			m.localRefusesValueOver2MB = a.limits.over2MB === 'refused';
			m.localRefuses101Parameters = a.limits.params101 === 'refused';
			check(a.largestValue === 1_827_097 || scale === 'smoke', 'the largest package value is the chronology dataset, 1,827,097 bytes: 91% of D1’s 2,000,000-byte limit');
			check(a.limits.params101 === 'refused', 'local D1 refuses a statement with 101 bound parameters (the 100 limit holds locally)');
			const time = async (url: string, init?: RequestInit) => {
				const t = performance.now();
				const r = await http(url, init);
				return { r, t: ms(t) };
			};
			await serve('client-a'); // a fresh workerd: the first requests are cold
			const docCold = await time(`/cases/${caseId}/documents/S-0001`);
			const docWarm = [];
			for (let k = 0; k < 5; k++) docWarm.push((await time(`/cases/${caseId}/documents/S-0001`)).t);
			check(docCold.r.status === 200 && docCold.r.json().name === 'S-0001', 'the document page reads its row by primary key from the active version');
			const chronCold = await time(`/cases/${caseId}/chronology`);
			const chronWarm = [];
			for (let k = 0; k < 5; k++) chronWarm.push((await time(`/cases/${caseId}/chronology`)).t);
			check(chronCold.r.status === 200 && chronCold.r.json().rows === p.listRows, 'the chronology view reads the list from R2, verified, and parses every row');
			const small = p.originals.find((o) => o.size > 1024 && o.size < MiB)!;
			const rng = await http(`/cases/${caseId}/originals/${small.assetId}`, { headers: { range: 'bytes=0-63' } });
			check(rng.status === 206, 'a range request of an original answers 206');
			const docWarmRes = await http(`/cases/${caseId}/documents/S-0002`);
			const chronWarmRes = await http(`/cases/${caseId}/chronology`);
			Object.assign(m, {
				documentPageD1Statements: probeCount(docWarmRes, 'd1-statements'),
				documentPageR2Ops: probeCount(docWarmRes, 'r2-ops'),
				chronologyD1Statements: probeCount(chronWarmRes, 'd1-statements'),
				chronologyR2Ops: probeCount(chronWarmRes, 'r2-ops'),
				originalRangeD1Statements: probeCount(rng, 'd1-statements'),
				originalRangeR2Ops: probeCount(rng, 'r2-ops'),
				coldDocumentMs: docCold.t,
				warmDocumentMs: median(docWarm),
				coldChronologyMs: chronCold.t,
				warmChronologyMs: median(chronWarm),
			});
			check(probeCount(docWarmRes, 'd1-statements') === 1 && probeCount(docWarmRes, 'r2-ops') === 0, 'a warm document page costs one D1 statement and no R2 operation');
			check(probeCount(chronWarmRes, 'd1-statements') === 1 && probeCount(chronWarmRes, 'r2-ops') === 1, 'a warm chronology view costs one D1 statement and one R2 GET');
			const candidate = await http(`/cases/${caseId}/versions/${V2}/files/manifest.json`);
			check(candidate.status === 404 && (await http(`/cases/${caseId}/versions/${V}/files/manifest.json`)).status === 200, "a stored candidate's files are not served while another version is published; the published version's are");
		});

		// ----- range delivery -----
		const largest = p.originals.reduce((a, b) => (b.size > a.size ? b : a));
		await leg('range', ['GET Range: bytes=0-63, bytes=100-163, bytes=-64 and bytes=<n>- on an original', 'GET Range: bytes=0-0,5-9 (several ranges)', 'GET Range: bytes=<size>-', 'HEAD with a range', 'GET of a whole original up to 32 MiB', 'GET of the largest original, whole (two passes)', 'GET Range: bytes=0-65535 on the largest original', 'GET of another case’s and an unknown asset', 'GET Range: bytes=0-63 on an asset of client B’s case through client A', 'GET Range: bytes=9-0'], async (check, m) => {
			const o = p.originals.find((x) => x.size > 4096 && x.size < 4 * MiB)!;
			const bytes = bytesOf(o);
			const u = `/cases/${caseId}/originals/${o.assetId}`;
			const get = (range: string) => http(u, { headers: { range } });
			const r1 = await get('bytes=0-63');
			check(r1.status === 206 && r1.headers.get('content-range') === `bytes 0-63/${o.size}` && equal(r1.bytes, bytes.subarray(0, 64)), 'bytes=0-63 answers 206 with exactly the first 64 bytes and their Content-Range');
			const r2 = await get('bytes=100-163');
			check(r2.status === 206 && equal(r2.bytes, bytes.subarray(100, 164)), 'a middle range answers exactly bytes 100 to 163');
			const r3 = await get('bytes=-64');
			check(r3.status === 206 && equal(r3.bytes, bytes.subarray(o.size - 64)) && r3.headers.get('content-range') === `bytes ${o.size - 64}-${o.size - 1}/${o.size}`, 'a suffix range answers the last 64 bytes');
			const r4 = await get(`bytes=${o.size - 10}-`);
			check(r4.status === 206 && equal(r4.bytes, bytes.subarray(o.size - 10)), 'an open-ended range answers through the last byte');
			const multi = await get('bytes=0-0,5-9');
			const past = await get(`bytes=${o.size}-`);
			const backwards = await get('bytes=9-0');
			check([multi, past, backwards].every((r) => r.status === 416 && r.headers.get('content-range') === `bytes */${o.size}` && r.bytes.length === 0), 'several ranges, a range past the end and a backwards range answer 416 with no bytes');
			const h = await http(u, { method: 'HEAD', headers: { range: 'bytes=0-63' } });
			check(h.status === 206 && h.bytes.length === 0 && h.headers.get('content-length') === '64', 'HEAD with a range answers its headers and no body');
			const whole = await http(u);
			check(whole.status === 200 && equal(whole.bytes, bytes) && whole.headers.get('etag') === `"${shas[o.index]}"`, 'a whole original up to 32 MiB answers 200 with exactly its bytes');
			const big = bytesOf(largest);
			let t = performance.now();
			const bigWhole = await http(`/cases/${caseId}/originals/${largest.assetId}`, { timeout: 600_000 });
			m.wholeLargestMs = ms(t);
			check(bigWhole.status === 200 && sha256(bigWhole.bytes) === shas[largest.index], `the largest original (${largest.size} bytes) answers 200 whole, its SHA-256 matching, through the two-pass path`);
			t = performance.now();
			const bigRange = await http(`/cases/${caseId}/originals/${largest.assetId}`, { headers: { range: 'bytes=0-65535' }, timeout: 600_000 });
			m.rangeOnLargestMs = ms(t);
			check(bigRange.status === 206 && equal(bigRange.bytes, big.subarray(0, 65536)), 'a 64 KiB range of the largest original answers exactly those bytes, after the whole object was hashed');
			check((await http(`/cases/case-other/originals/${o.assetId}`)).status === 404 && (await http(`/cases/${caseId}/originals/orig-none`)).status === 404, "an asset id under another case, or an unknown asset, answers 404");
			check((await get('bytes=0-63')).status === 206 && (await http('/cases/case-b1/originals/orig-0001', { headers: { range: 'bytes=0-63' } })).status === 404, "client A's deployment knows no asset of client B's case (404, from A's own database)");
			m.largestOriginalBytes = largest.size;
			m.workerdPeakRssBytes = workerdPeak(server!);
		});


		// ----- write-once: a key a D1 row records, or that holds verified bytes, is never deleted or overwritten -----
		await leg('write-once', ['PUT /originals/<sha256>, POST /cases/case-wo-1/originals (finalize), GET Range: bytes=0-63', 'POST /cases/case-wo-2/originals with the same SHA-256 and a wrong size', 'POST /originals/<sha>/uploads, PUT …/1 (other bytes), PUT /originals/<sha> and finalize, then POST …/complete over the recorded key', 'POST …/uploads and …/complete with bytes other than the key names, finalize, GET /probe/head/orig/<sha>', 'POST /cases/case-wo-1/originals binding an asset to another original'], async (check, m) => {
			const synthetic = (label: string, n: number) => new TextEncoder().encode(`SYNTHETIC ONLY: ${label}\n`.repeat(n));
			const A = synthetic('write-once original A', 600);
			const B = synthetic('write-once original B', 500);
			const J = synthetic('bytes other than the ones the key names', 300);
			const [hA, hB, hJ] = [sha256(A), sha256(B), sha256(synthetic('the digest a client claims', 300))];
			const finalize = (caseId: string, assetId: string, h: string, size: number) => post(`/cases/${caseId}/originals`, { assetId, sha256: h, size, filename: `${assetId}.pdf`, mediaType: 'application/pdf' });
			const served = async (caseId: string, assetId: string, bytes: Uint8Array) => {
				const r = await http(`/cases/${caseId}/originals/${assetId}`, { headers: { range: 'bytes=0-63' } });
				const w = await http(`/cases/${caseId}/originals/${assetId}`);
				return r.status === 206 && equal(r.bytes, bytes.subarray(0, 64)) && w.status === 200 && equal(w.bytes, bytes);
			};
			const held = async (sha: string) => {
				const r = await http(`/probe/head/orig/${sha}`);
				return r.status === 200 ? { size: r.json().size as number, sha256: r.json().sha256 as string | null } : null;
			};
			let refused = 0;
			check((await http(`/originals/${hA}`, { method: 'PUT', body: A })).status === 200 && (await finalize('case-wo-1', 'wo-letter', hA, A.length)).status === 200 && (await served('case-wo-1', 'wo-letter', A)), 'an original is uploaded and finalized in case 1, and its range and whole GET serve its bytes');
			const wrongSize = await finalize('case-wo-2', 'wo-other', hA, A.length + 1);
			if (wrongSize.status === 409 && wrongSize.json().code === 'digest-mismatch') refused++;
			check(wrongSize.status === 409 && wrongSize.json().code === 'digest-mismatch' && wrongSize.json().check === 'size', "case 2 finalizing the same SHA-256 with a wrong size answers 409 digest-mismatch (size), not a deletion of case 1's original");
			check((await held(hA))?.sha256 === hA && (await served('case-wo-1', 'wo-letter', A)) && (await http('/cases/case-wo-2/originals/wo-other')).status === 404, "case 1's original is still stored and served byte for byte after the refused finalize, and case 2 recorded nothing");
			const up = (await post(`/originals/${hB}/uploads`, {})).json();
			const part = await http(`/originals/${hB}/uploads/${up.uploadId}/1`, { method: 'PUT', body: synthetic('other bytes under B’s key', 700) });
			check(part.status === 200 && (await http(`/originals/${hB}`, { method: 'PUT', body: B })).status === 200 && (await finalize('case-wo-1', 'wo-b', hB, B.length)).status === 200, 'a second original is stored and recorded while a multipart upload for the same key is still open');
			const over = await post(`/originals/${hB}/uploads/${up.uploadId}/complete`, { parts: [part.json()] });
			if (over.status === 409 && over.json().code === 'conflicting-object') refused++;
			check(over.status === 409 && over.json().code === 'conflicting-object' && (await held(hB))?.sha256 === hB && (await served('case-wo-1', 'wo-b', B)), 'completing that multipart upload over the recorded key answers 409 conflicting-object, and the recorded original is served unchanged');
			const uj = (await post(`/originals/${hJ}/uploads`, {})).json();
			const pj = await http(`/originals/${hJ}/uploads/${uj.uploadId}/1`, { method: 'PUT', body: J });
			check(pj.status === 200 && (await post(`/originals/${hJ}/uploads/${uj.uploadId}/complete`, { parts: [pj.json()] })).status === 200, 'a multipart upload whose bytes are not the ones its key names completes: R2 checks no SHA-256 for multipart');
			const junk = await finalize('case-wo-1', 'wo-junk', hJ, J.length);
			if (junk.status === 409 && junk.json().code === 'digest-mismatch') refused++;
			check(junk.status === 409 && junk.json().code === 'digest-mismatch' && junk.json().check === 'sha256' && (await held(hJ))?.size === J.length && (await http('/cases/case-wo-1/originals/wo-junk')).status === 404, 'finalizing it answers 409 digest-mismatch (sha256), records nothing and deletes nothing: the unrecorded object stays for a reaper');
			const rebind = await finalize('case-wo-1', 'wo-letter', hB, B.length);
			if (rebind.status === 409 && rebind.json().code === 'asset-bound-to-another-original') refused++;
			check(rebind.status === 409 && rebind.json().code === 'asset-bound-to-another-original' && (await served('case-wo-1', 'wo-letter', A)), 'binding a recorded asset to another original answers 409 and the asset still serves the first');
			m.refusedWrites = refused;
		});

		// ----- two-pass: the bytes a client receives are the bytes that were hashed, or the response ends in an error -----
		await leg('two-pass', ['PUT /originals/<sha256> (40 MiB) and POST /cases/case-tp/originals (finalize)', 'GET the original whole and Range: bytes=0-36700159, nothing changed', 'GET the original whole; one byte of its R2 blob changed once the headers are back', 'GET Range: bytes=0-36700159; one byte inside the range changed after the headers', 'GET Range: bytes=0-36700159; one byte outside the range changed after the headers'], async (check, m) => {
			const big = new Uint8Array(40 * MiB);
			for (let i = 0, x = 0x9e3779b9; i < big.length; i++) ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (big[i] = x & 0xff));
			big.set(new TextEncoder().encode('SYNTHETIC ONLY: two-pass original\n'));
			const h = sha256(big);
			const url = `${BASE}/cases/case-tp/originals/tp-big`;
			const rangeEnd = 35 * MiB - 1;
			check((await http(`/originals/${h}`, { method: 'PUT', body: big as Uint8Array<ArrayBuffer>, timeout: 300_000 })).status === 200 && (await post('/cases/case-tp/originals', { assetId: 'tp-big', sha256: h, size: big.length, filename: 'tp-big.pdf', mediaType: 'application/pdf' }, 300_000)).status === 200, 'a 40 MiB original, over the 32 MiB buffer, is uploaded and finalized');
			const whole = await http('/cases/case-tp/originals/tp-big', { timeout: 300_000 });
			const range = await http('/cases/case-tp/originals/tp-big', { headers: { range: `bytes=0-${rangeEnd}` }, timeout: 300_000 });
			check(whole.status === 200 && sha256(whole.bytes) === h && range.status === 206 && equal(range.bytes, big.subarray(0, rangeEnd + 1)), 'unchanged, the whole GET and a 35 MiB range answer exactly their bytes');
			// Headers are back once the first pass has hashed the object; one byte of the stored blob then changes (size, ETag and
			// recorded digest as before) and the body is read. The response must end in an error before its last byte.
			let refused = 0;
			const race = async (init: RequestInit, at: number, want: number) => {
				let res: Response;
				for (let attempt = 1; ; attempt++) {
					res = await fetch(url, { ...init, signal: AbortSignal.timeout(300_000) });
					if (res.status !== 500 || attempt > 2) break; // Wrangler's dev proxy sometimes drops a request before the Worker runs
					await res.arrayBuffer();
				}
				const flipped = flip('storage-a', big.length, h, at);
				const out = await drain(res);
				const bad = Uint8Array.from(big);
				bad[at] = bad[at]! ^ 0xff;
				const restored = flip('storage-a', big.length, sha256(bad), at);
				const ended = (res.status === 200 || res.status === 206) && (out.error !== null || out.received < want);
				if (ended) refused++;
				return { flipped: flipped === 1 && restored === 1, ended, status: res.status, ...out };
			};
			const w = await race({}, big.length - 1000, big.length);
			check(w.flipped && w.ended, `the whole GET errors before its end when a byte changes after its headers (${w.status}, ${w.received} of ${big.length} bytes, ${w.error ?? 'no error'})`);
			const inside = await race({ headers: { range: `bytes=0-${rangeEnd}` } }, 34 * MiB, rangeEnd + 1);
			check(inside.flipped && inside.ended, `a 35 MiB range errors before its end when a byte inside it changes (${inside.status}, ${inside.received} of ${rangeEnd + 1} bytes, ${inside.error ?? 'no error'})`);
			const outside = await race({ headers: { range: `bytes=0-${rangeEnd}` } }, 39 * MiB, rangeEnd + 1);
			check(outside.flipped && outside.ended, `a 35 MiB range errors before its end when a byte outside it changes, because the digest covers the whole object (${outside.status}, ${outside.received} of ${rangeEnd + 1} bytes, ${outside.error ?? 'no error'})`);
			const again = await http('/cases/case-tp/originals/tp-big', { timeout: 300_000 });
			check(again.status === 200 && sha256(again.bytes) === h, 'with the byte put back, the whole GET answers exactly the original');
			m.originalBytes = big.length;
			m.changedReadsRefused = refused;
		});

		// ----- user work (P4) -----
		await leg('user-work', ['100 concurrent POST /cases/<case>/registers/{a,b}/add', '100 concurrent POST …/naive-add (control: read, then write)', 'POST …/add again with an operationId already used', '20 concurrent POST …/replace with one expected version', 'POST …/remove with a stale, then the current version; …/replace after removal', 'GET /cases/<case>/work?backup=1 (snapshot)', 'POST /cases/<case>/work/restore with a stale rev', 'POST …/work/restore with an injected failure after the deletes', 'POST …/work/restore with a snapshot lacking a table', 'POST …/work/restore with the current rev', 'POST …/work/restore racing 20 adds', 'GET /cases/<case>/work'], async (check, m) => {
			const add = (store: string, i: number) => post(`/cases/${caseId}/registers/${store}/add`, { fields: { label: `synthetic ${store} ${i}` }, operationId: `op-${store}-${i}` });
			const adds = await Promise.all(Array.from({ length: 100 }, (_, i) => add(i % 2 ? 'a' : 'b', i)));
			check(adds.every((r) => r.status === 200), 'every one of 100 concurrent adds is written');
			const seqs = (store: string) => adds.map((r) => r.json()).filter((b, i) => (i % 2 ? 'a' : 'b') === store).map((b) => b.seq as number).sort((x, y) => x - y);
			const dense = (xs: number[]) => xs.every((s, i) => s === i + 1);
			check(dense(seqs('a')) && dense(seqs('b')), 'each store’s seq runs 1 to 50 with no gap and no duplicate');
			const revs = adds.map((r) => r.json().rev as number).sort((x, y) => x - y);
			check(new Set(revs).size === 100 && revs[0]! >= 1, 'each add moved the case revision exactly once');
			const naive = await Promise.all(Array.from({ length: 100 }, () => post(`/cases/${caseId}/registers/a/naive-add`, {})));
			const naiveSeqs = naive.map((r) => r.json().seq as number);
			const naiveDupes = naiveSeqs.length - new Set(naiveSeqs).size;
			check(naiveDupes > 0, `the control (read, then write) duplicates seq under the same load (${naiveDupes} duplicates), so the probe can see the defect it rules out`);
			const rep = await add('a', 3);
			check(rep.status === 200 && rep.json().repeated === true && rep.json().seq === adds[3]!.json().seq, 'an add repeated with its operationId is recognised (repeated) and writes nothing');
			const target = adds[1]!.json();
			const raced = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`/cases/${caseId}/registers/a/replace`, { rowId: target.rowId, expected: target.version, fields: { label: `replaced ${i}` } })));
			const written = raced.filter((r) => r.status === 200);
			const stale = raced.filter((r) => r.status === 409 && r.json().kind === 'stale');
			check(written.length === 1 && stale.length === 19, 'of 20 concurrent replaces with one expected version exactly one is written and 19 are stale');
			const victim = adds[5]!.json();
			check((await post(`/cases/${caseId}/registers/a/remove`, { rowId: victim.rowId, expected: '00000000-0000-4000-8000-000000000000' })).json().kind === 'stale', 'a remove with a stale version answers stale and removes nothing');
			check((await post(`/cases/${caseId}/registers/a/remove`, { rowId: victim.rowId, expected: victim.version })).status === 200 && (await post(`/cases/${caseId}/registers/a/replace`, { rowId: victim.rowId, expected: victim.version, fields: {} })).json().kind === 'gone', 'a remove with the current version is written; a replace after it answers gone');
			const snapRes = await http(`/cases/${caseId}/work?backup=1`);
			const snap = snapRes.json();
			check(snapRes.status === 200 && Object.keys(snap.tables).join() === 'uw_note,uw_register_row' && snap.backup.key.startsWith(`backup/${caseId}/snapshot-`), 'the snapshot covers every uw_ table sqlite_master lists, and its backup is in R2');
			const { backup: _b, ...snapshot } = snap;
			const before = sha256((await http(`/cases/${caseId}/work`)).bytes);
			for (let i = 0; i < 5; i++) await add('b', 1000 + i);
			const afterAdds = (await http(`/cases/${caseId}/work`)).json();
			const staleRestore = await post(`/cases/${caseId}/work/restore`, { expectedRev: snapshot.rev, snapshot });
			check(staleRestore.status === 409 && staleRestore.json().kind === 'stale' && sha256(JSON.stringify(afterAdds)) === sha256((await http(`/cases/${caseId}/work`)).bytes), 'a restore against a revision that moved answers stale and changes nothing');
			const failed = await post(`/cases/${caseId}/work/restore`, { expectedRev: afterAdds.rev, snapshot, failAfterDelete: true });
			check(failed.status === 409 && failed.json().kind === 'rolled-back' && sha256(JSON.stringify(afterAdds)) === sha256((await http(`/cases/${caseId}/work`)).bytes), 'a restore whose batch fails after its deletes rolls back whole: every row and the revision are as before');
			const { uw_note: _n, ...lacking } = snapshot.tables;
			const partial = await post(`/cases/${caseId}/work/restore`, { expectedRev: afterAdds.rev, snapshot: { ...snapshot, tables: lacking } });
			check(partial.status === 422 && partial.json().code === 'snapshot-incomplete' && partial.json().table === 'uw_note', 'a snapshot lacking a case table is refused, naming the table: a restore never leaves tables the snapshot lacks');
			const ok = await post(`/cases/${caseId}/work/restore`, { expectedRev: afterAdds.rev, snapshot });
			const restored = (await http(`/cases/${caseId}/work`)).json();
			check(ok.status === 200 && JSON.stringify(restored.tables) === JSON.stringify(snapshot.tables) && restored.rev === afterAdds.rev + 1 && ok.json().preRestore.startsWith(`backup/${caseId}/pre-restore-`), 'a restore at the current revision replaces the case’s user work whole with the snapshot, after a durable pre-restore copy');
			void before;
			// Race: a restore against 20 concurrent adds. Every add lands either before the restore (and is wiped, or makes
			// the restore stale) or after it (and stays); never half.
			const cur = restored.rev as number;
			const [race, ...raceAdds] = await Promise.all([post(`/cases/${caseId}/work/restore`, { expectedRev: cur, snapshot }), ...Array.from({ length: 20 }, (_, i) => add('c', 2000 + i))]);
			const final = (await http(`/cases/${caseId}/work`)).json();
			const cRows = (final.tables.uw_register_row.rows as { store: string; seq: number; operation_id: string }[]).filter((r) => r.store === 'c');
			const addRevs = raceAdds.map((r) => r.json().rev as number);
			// Each add committed either before the restore (wiped by it, or making it stale) or after it (kept); never half.
			const restoredAt = race.status === 200 ? (race.json().rev as number) : null;
			const kept = (i: number) => cRows.some((r) => r.operation_id === `op-c-${2000 + i}`);
			check(raceAdds.every((r) => r.status === 200) && (race.status === 200 || race.json().kind === 'stale'), 'every racing add is written, and the restore is written or answers stale');
			check(raceAdds.every((_, i) => kept(i) === (restoredAt === null || addRevs[i]! > restoredAt)) && cRows.length === raceAdds.filter((_, i) => kept(i)).length, 'exactly the adds after the restore’s revision remain (all of them when the restore was stale): no half-applied restore');
			const raceKind = restoredAt === null ? 'adds-first' : addRevs.every((r) => r > restoredAt) ? 'restore-first' : 'interleaved';
			check(final.rev === Math.max(cur, ...addRevs, race.status === 200 ? race.json().rev : 0), 'the final revision is the last write’s');
			Object.assign(m, { concurrentAdds: 100, duplicateSeqs: 100 - new Set(adds.map((r) => `${r.json().seq}/${adds.indexOf(r) % 2}`)).size, naiveDuplicateSeqs: naiveDupes, racedReplaces: 20, staleReplaces: stale.length, restoreRace: raceKind });
		});

		// ----- export (P7) -----
		const packet = path.join(scratch, 'packet.zip');
		let packetSha = '';
		let sourceState = '';
		let exportEntries = 0;
		await leg('export', ['POST /cases/<case>/exports', 'POST /cases/<case>/exports/<id>/step until complete (one multipart part each)', 'POST …/seal (the packet hashed whole)', 'GET /cases/<case>/exports/<id> (two-pass verified download), then again with one byte of the packet changed after the headers', 'python3 -I (zipfile): open the packet offline, every entry’s CRC and the manifest’s SHA-256 and size', 'GET /cases/<case>/state'], async (check, m) => {
			const t0 = performance.now();
			const start = await post(`/cases/${caseId}/exports`, {}, 600_000);
			check(start.status === 200, 'an export job starts from the active version, with a manifest of every entry');
			const { exportId, entries } = start.json();
			exportEntries = entries;
			let steps = 0;
			let maxR2 = 0;
			let maxD1 = 0;
			let last: any = null;
			for (;;) {
				const s = await post(`/cases/${caseId}/exports/${exportId}/step`, {}, 600_000);
				if (s.status !== 200) throw new Error(`export step ${steps}: ${s.status} ${new TextDecoder().decode(s.bytes).slice(0, 300)}`);
				steps++;
				maxR2 = Math.max(maxR2, probeCount(s, 'r2-ops'));
				maxD1 = Math.max(maxD1, probeCount(s, 'd1-statements'));
				last = s.json();
				if (last.complete) break;
			}
			check(last.next === entries, `the export completes in ${steps} steps, each writing one part`);
			const seal = await post(`/cases/${caseId}/exports/${exportId}/seal`, {}, 600_000);
			check(seal.status === 200 && seal.json().complete === true, 'seal hashes the completed packet whole and records its size and SHA-256');
			m.wallMs = ms(t0);
			m.workerdPeakRssBytes = workerdPeak(server!);
			const res = await fetch(`${BASE}/cases/${caseId}/exports/${exportId}`, { signal: AbortSignal.timeout(900_000) });
			check(res.status === 200 && res.headers.get('x-packet-sha256') === seal.json().sha256, 'the packet downloads after a whole-object verification');
			const fd = openSync(packet, 'w');
			const hash = createHash('sha256');
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) (hash.update(chunk), writeSync(fd, chunk));
			closeSync(fd);
			packetSha = hash.digest('hex');
			check(packetSha === seal.json().sha256 && statSync(packet).size === seal.json().size, 'the downloaded bytes match the sealed SHA-256 and size');
			// The same race as the two-pass leg, on the packet: a byte changes after the headers, and the download must end in an error.
			const packetSize = seal.json().size as number;
			const raced = await fetch(`${BASE}/cases/${caseId}/exports/${exportId}`, { signal: AbortSignal.timeout(900_000) });
			const flippedPacket = flip('storage-a', packetSize, null, packetSize - 1000);
			const drained = await drain(raced);
			flip('storage-a', packetSize, null, packetSize - 1000);
			const ended = raced.status === 200 && (drained.error !== null || drained.received < packetSize);
			check(flippedPacket === 1 && (ended || (scale === 'smoke' && drained.sha256 === packetSha)), `a packet download errors before its end when a byte of the packet changes after its headers (${drained.received} of ${packetSize} bytes, ${drained.error ?? 'no error'}); at smoke scale the packet may be read before the byte changes, and then it must be intact`);
			const t1 = performance.now();
			const py = run('/usr/bin/python3', ['-I', '-c', PY_CHECK, packet], { env: { PATH: '/usr/bin:/bin' } });
			m.offlineCheckMs = ms(t1);
			writeFileSync(path.join(logs, 'packet-offline-check.log'), py.out);
			const pyOut = py.code === 0 ? (JSON.parse(py.stdout.trim().split('\n').at(-1)!) as { entries: number; bytes: number; client: string; caseId: string }) : null;
			check(py.code === 0 && pyOut!.entries === entries - 1 && pyOut!.client === 'client-a' && pyOut!.caseId === caseId, `Python's zipfile opens the packet offline: every entry's CRC-32 and the manifest's SHA-256 and size match (${py.out.trim().slice(-200)})`);
			const st = await http(`/cases/${caseId}/state`, { timeout: 600_000 });
			sourceState = st.json().sha256;
			check(st.status === 200 && st.json().counts.missing === 0 && st.json().counts.originals === p.originals.length, 'the source deployment’s state digest covers the case’s rows and every object, none missing');
			Object.assign(m, { entries, packetBytes: seal.json().size, parts: last.parts, steps, maxR2OpsPerStep: maxR2, maxD1StatementsPerStep: maxD1 });
		});

		// ----- corruption (P8): at rest, truncated, replaced, deleted, in pkg/, rm/ and orig/ -----
		await leg('corruption', ['flip one byte at offset 100 of an original’s blob in the local R2 store (same size, same etag)', 'GET Range: bytes=0-63, GET and HEAD of it', 'POST /cases/<case>/exports and …/step until it fails', wcmd('r2 object put storage-a/orig/<sha> --local --file <truncated>'), wcmd('r2 object put storage-a/orig/<sha> --local --file <same size, other bytes>'), wcmd('r2 object delete storage-a/orig/<sha> --local'), 'GET Range: bytes=0-63 of each', 'flip one byte of the chronology dataset’s blob (pkg/)', 'GET /cases/<case>/verify and GET …/files/datasets/chronology.json', wcmd('r2 object put storage-a/rm/<v>/chronology.json --local --file <replaced>'), 'GET /cases/<case>/chronology'], async (check, m) => {
			let refused = 0;
			const noBytes = (r: Res, original: Uint8Array) => {
				const text = Buffer.from(r.bytes);
				return !text.includes(Buffer.from(original.subarray(0, 64))) && (r.bytes.length === 0 || r.type.startsWith('application/json'));
			};
			const pick = (k: number) => p.originals.filter((o) => o.size > 4096 && o.size < 4 * MiB)[k]!;
			// a. at-rest corruption outside the first 64 bytes
			const a = pick(0);
			const aBytes = bytesOf(a);
			check(flip('storage-a', a.size, shas[a.index]!, 100) > 0, 'the original’s blob is found in the local R2 store by size and SHA-256, and one byte at offset 100 is flipped');
			const ar = await http(`/cases/${caseId}/originals/${a.assetId}`, { headers: { range: 'bytes=0-63' } });
			const aw = await http(`/cases/${caseId}/originals/${a.assetId}`);
			const ah = await http(`/cases/${caseId}/originals/${a.assetId}`, { method: 'HEAD' });
			const ok = (r: Res) => r.status === 410 && noBytes(r, aBytes);
			check(ok(ar) && ar.json().code === 'changed-original' && ar.json().check === 'sha256', 'Range: bytes=0-63 of the corrupted original answers 410 changed-original, with none of its bytes, though bytes 0 to 63 are intact');
			check(ok(aw) && ah.status === 410, 'the whole GET and the HEAD answer 410 too');
			refused += 1;
			const ex = await post(`/cases/${caseId}/exports`, {}, 600_000);
			let failedStep: Res | null = null;
			for (let k = 0; k < 2000 && ex.status === 200; k++) {
				const s = await post(`/cases/${caseId}/exports/${ex.json().exportId}/step`, {}, 600_000);
				if (s.status !== 200 || s.json().complete) {
					failedStep = s;
					break;
				}
			}
			const job = (await http(`/cases/${caseId}/exports/${ex.json().exportId}/job`)).json();
			const packetKey = `storage-a/export/${caseId}/${ex.json().exportId}.zip`;
			check(failedStep?.status === 410 && job.state === 'failed' && wrangler('r2', 'object', 'get', packetKey, '--local', '--env', 'client-a', '--pipe').code !== 0, 'an export that reaches the corrupted original fails closed: 410, the job failed, its multipart upload aborted and no packet object');
			refused += 1;
			// b to d need the CLI: stop the server so only one process holds the local store
			await stopServer(server!);
			server = null;
			const b = pick(1);
			const c = pick(2);
			const d = pick(3);
			const write = (name: string, bytes: Uint8Array) => {
				const f = path.join(scratch, name);
				writeFileSync(f, bytes);
				return f;
			};
			const bBytes = bytesOf(b);
			const cBytes = bytesOf(c);
			const other = Uint8Array.from(cBytes);
			other[200] = other[200]! ^ 0x01;
			check(r2put('client-a', 'storage-a', `orig/${shas[b.index]}`, write('truncated', bBytes.subarray(0, b.size - 1))).code === 0 && r2put('client-a', 'storage-a', `orig/${shas[c.index]}`, write('replaced', other)).code === 0 && wrangler('r2', 'object', 'delete', `storage-a/orig/${shas[d.index]}`, '--local', '--env', 'client-a').code === 0, 'one original is truncated, one replaced by bytes of the same size, one deleted, each through the R2 CLI as a credential holder would');
			// e. pkg/ at rest; f. rm/ replaced
			const chron = files.find((f) => f.path === 'datasets/chronology.json')!;
			check(flip('storage-a', chron.size, chron.sha256, 1000) > 0, 'one byte of the chronology dataset’s blob (pkg/) is flipped at rest');
			await serve('client-a');
			const br = await http(`/cases/${caseId}/originals/${b.assetId}`, { headers: { range: 'bytes=0-63' } });
			const cr = await http(`/cases/${caseId}/originals/${c.assetId}`, { headers: { range: 'bytes=0-63' } });
			const dr = await http(`/cases/${caseId}/originals/${d.assetId}`, { headers: { range: 'bytes=0-63' } });
			check(br.status === 410 && br.json().check === 'size' && noBytes(br, bBytes), 'the truncated original answers 410 (size), no bytes');
			check(cr.status === 410 && cr.json().check === 'sha256' && noBytes(cr, cBytes), 'the replaced original of the same size answers 410 (sha256), no bytes');
			check(dr.status === 410 && dr.json().code === 'missing-original', 'the deleted original answers 410 missing-original');
			refused += 3;
			const ver = await http(`/cases/${caseId}/verify`);
			const pf = await http(`/cases/${caseId}/versions/${V}/files/datasets/chronology.json`);
			check(ver.status === 410 && ver.json().key === `pkg/${V}/datasets/chronology.json` && pf.status === 410 && !Buffer.from(pf.bytes).includes(Buffer.from('"synthetic":true')), 'the version check and the file route refuse the corrupted package file (410 naming its key), serving none of it');
			refused += 2;
			await stopServer(server!);
			server = null;
			const replacedList = Buffer.from(list);
			replacedList[10] = replacedList[10]! ^ 0x01;
			check(r2put('client-a', 'storage-a', `rm/${V}/chronology.json`, write('list', replacedList)).code === 0, 'the list (rm/) is replaced by bytes of the same size');
			await serve('client-a');
			const cl = await http(`/cases/${caseId}/chronology`);
			check(cl.status === 410 && cl.json().check === 'sha256', 'the chronology view refuses the replaced list (410)');
			refused += 1;
			m.casesRefused = refused;
		});

		// ----- restore (P7): the packet, offline, into a fresh deployment -----
		await leg('restore', [serveCmd('client-b'), 'POST /restore/packets, PUT …/<part> (64 MiB parts), POST …/complete, POST …/open (client B)', serveCmd('restore-a'), 'POST /restore/packets, PUT …/<part>, POST …/complete (restore-a)', 'POST /restore/packets/<id>/open', 'POST …/step until done', 'POST …/finish', 'GET /cases/<case>/state, GET …/originals/<asset> Range: bytes=0-63'], async (check, m) => {
			const uploadPacket = async () => {
				const c = (await post('/restore/packets', {})).json();
				const fd = openSync(packet, 'r');
				const parts = [];
				const total = statSync(packet).size;
				const buf = Buffer.alloc(64 * MiB);
				for (let off = 0, n = 1; off < total; off += 64 * MiB, n++) {
					const len = readSync(fd, buf, 0, Math.min(64 * MiB, total - off), off);
					const r = await http(`/restore/packets/${c.packetId}/${c.uploadId}/${n}`, { method: 'PUT', body: buf.subarray(0, len), timeout: 600_000 });
					if (r.status !== 200) throw new Error(`packet part ${n}: ${r.status}`);
					parts.push(r.json());
				}
				closeSync(fd);
				const done = await post(`/restore/packets/${c.packetId}/${c.uploadId}/complete`, { parts });
				if (done.status !== 200 || done.json().size !== total) throw new Error(`packet complete: ${done.status}`);
				return c.packetId as string;
			};
			await serve('client-b');
			const wrong = await post(`/restore/packets/${await uploadPacket()}/open`, {});
			check(wrong.status === 409 && wrong.json().code === 'wrong-client', "client A's packet uploaded to client B's deployment is refused on open (409 wrong-client)");
			await serve('restore-a');
			const t0 = performance.now();
			const id = await uploadPacket();
			const opened = await post(`/restore/packets/${id}/open`, {});
			check(opened.status === 200 && opened.json().entries === exportEntries && opened.json().caseId === caseId, 'the fresh deployment opens the packet from its central directory and manifest, entry for entry');
			let from = 1;
			let steps = 0;
			for (;;) {
				const s = await post(`/restore/packets/${id}/step`, { from }, 600_000);
				if (s.status !== 200) throw new Error(`restore step: ${s.status} ${new TextDecoder().decode(s.bytes).slice(0, 300)}`);
				steps++;
				from = s.json().next;
				if (from >= exportEntries) break;
			}
			check(true, `every object entry is copied to its key in ${steps} steps, R2 checking each against the manifest's SHA-256 and the archive's CRC-32`);
			const fin = await post(`/restore/packets/${id}/finish`, {}, 600_000);
			check(fin.status === 200 && fin.json().restored === caseId, 'finish rebuilds the version, read model, originals, activation and user work through the guarded import path');
			m.wallMs = ms(t0);
			const st = await http(`/cases/${caseId}/state`, { timeout: 600_000 });
			check(st.status === 200 && st.json().sha256 === sourceState, 'the restored deployment’s state digest equals the source’s, taken before any corruption: rows, user work and every object');
			const o = p.originals.find((x) => x.size > 4096 && x.size < 4 * MiB)!;
			const r = await http(`/cases/${caseId}/originals/${o.assetId}`, { headers: { range: 'bytes=0-63' } });
			check(r.status === 206 && equal(r.bytes, bytesOf(o).subarray(0, 64)), 'an original that was corrupted at the source is served intact, verified, from the restored deployment');
			const work = await http(`/cases/${caseId}/work`);
			check(work.status === 200 && work.json().tables.uw_register_row.rows.length > 0, 'the restored user work is readable');
			const again = await post(`/restore/packets/${id}/finish`, {}, 600_000);
			check(again.status === 409 && again.json().code === 'already-restored' && (await http(`/cases/${caseId}/state`, { timeout: 600_000 })).json().sha256 === sourceState, 'finishing the same restore again answers 409 already-restored and changes nothing');
			Object.assign(m, { entries: exportEntries, steps, objects: st.json().counts.objects });
		});
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	} finally {
		for (const s of [...live]) await stopServer(s).catch((e: unknown) => (failure ??= String(e)));
		server = null;
	}
	if (!keepState) rmSync(persist, { recursive: true, force: true }), rmSync(scratch, { recursive: true, force: true });
	void rel;

	const endSha = head();
	const clean = !dirty() && !allowDirty; // a development run on a dirty tree is never evidence
	const summary: Record<string, unknown> = {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: clean && endSha === sha,
		scale,
		seed: SEED,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: process.versions.bun, node: node.version, workerd: pins.workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node.version}`, app: `workerd ${pins.workerd} (native)` },
		pins,
		artifact,
		isolation: { network: isolation, env: Object.keys(env).sort() },
		corpus: { target: JSON.parse(JSON.stringify(V5)), generated: aggregates(p) },
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
	if (!clean || endSha !== sha) console.log(`FAIL    tree changed during the run (HEAD ${endSha.slice(0, 12)}, clean ${clean})`);
	console.log(`${summary.evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} scale: ${scale} evidence: ${summary.evidence} summary: ${path.relative(root, out)}`);
	return summary.evidence ? 0 : 1;
}

/** Opens the packet with Python's zipfile, offline: reading each entry to its end checks its CRC-32; then its SHA-256 and size against the manifest. */
const PY_CHECK = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
m = json.loads(z.read('manifest.json'))
assert names == ['manifest.json'] + [e['path'] for e in m['entries']], 'entries differ from the manifest'
total = 0
for e in m['entries']:
    h = hashlib.sha256(); n = 0
    with z.open(e['path']) as f:
        while True:
            b = f.read(1 << 22)
            if not b: break
            h.update(b); n += len(b)
    assert h.hexdigest() == e['sha256'] and n == e['size'], 'entry ' + e['path'] + ' differs from the manifest'
    total += n
print(json.dumps({'entries': len(m['entries']), 'bytes': total, 'client': m['client'], 'caseId': m['caseId']}))
`;

function enterOffline(args: string[]): number {
	const node = realNode();
	const offline = path.join(repo(), 'tests/e2e/pilot/offline.sh');
	const ids = (flag: string) => run('id', [flag], { env: { PATH: '/usr/bin:/bin' } }).out.trim();
	const r = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${ids('-u')}`, `OUTER_GID=${ids('-g')}`, offline, process.execPath, import.meta.filename, '--inside', ...args], {
		cwd: HERE,
		stdio: 'inherit',
		env: { PATH: `${path.dirname(node.path)}:/usr/bin:/bin` },
	});
	return r.status ?? 1;
}

if (process.argv[1] === import.meta.filename) {
	const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'string' }, inside: { type: 'boolean' }, scale: { type: 'string', default: 'poc' }, 'keep-state': { type: 'boolean' }, 'allow-dirty': { type: 'boolean' } } });
	try {
		if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
		if (values.check) {
			const problems = checkSummary(JSON.parse(readFileSync(values.check, 'utf8')), head());
			for (const problem of problems) console.log(`refused: ${problem}`);
			console.log(problems.length ? `CHECK FAIL ${values.check}` : `CHECK PASS ${values.check}`);
			process.exit(problems.length ? 1 : 0);
		}
		if (values.scale !== 'poc' && values.scale !== 'smoke') throw new Refusal('--scale is poc or smoke');
		const out = path.resolve(values.out ?? path.join(repo(), '.local/hosting-probe/storage/summary.json'));
		if (!values.inside) process.exit(enterOffline(['--out', out, '--scale', values.scale, ...(values['keep-state'] ? ['--keep-state'] : []), ...(values['allow-dirty'] ? ['--allow-dirty'] : [])]));
		if (process.env.CLEARCASE_OFFLINE !== '1') throw new Refusal('--inside runs only under tests/e2e/pilot/offline.sh');
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void Promise.allSettled([...live].map(stopServer)).then(() => process.exit(130)));
		process.exit(await main(out, values.scale, values['keep-state'] === true, values['allow-dirty'] === true));
	} catch (e) {
		if (!(e instanceof Refusal)) throw e;
		console.error(`PROBE REFUSED: ${e.message}`);
		process.exit(2);
	}
}
