// The local workerd leg of the Workers runtime proof (GRS-106). From this directory:
//
//   bun install --frozen-lockfile   # once, online: this workspace's own pins, apart from the root lockfile
//   bun run --bun probe [--out FILE]
//   bun run --bun probe --check FILE
//
// The first form builds the probe app with Bun for adapter-cloudflare, serves it on native workerd through
// `wrangler dev --local` with local D1 and R2 (Node hosts Wrangler only; Bun hosts the build, this runner and its
// requests), and checks each leg. It runs inside tests/e2e/pilot/offline.sh: a new network namespace with only loopback
// up and the host resolver hidden, so no Cloudflare account, login or request is possible. Every child gets an explicit
// environment allowlist. It refuses (exit 2) a dirty tree, Bun other than packageManager's, an installed package that
// is not its pin, or a Node that is really Bun; otherwise it writes the summary (default
// .local/hosting-probe/runtime/summary.json) and exits 0 only when `evidence` is true: every leg PASS, the served build
// stamped with HEAD, and HEAD and the tree unchanged at the end. Logs and local D1/R2 state stay in the run directory
// under .local/hosting-probe/runtime/.
//
// `--check FILE` refuses (exit 1) a summary that is not this runner's PASS for HEAD. It compares the whole summary with one
// expected shape (expectedShape): exact key sets at every level, types and values, so a missing, null, retyped, extra or
// changed field fails, as does any leg that is not PASS or has a `failure`. check-mutations.ts in this directory mutates
// every leaf of a real PASS summary and runs this check on each (bun run --bun test:check).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
const SCHEMA = 'clearcase.runtime-probe/1';
const LEGS = ['build', 'request', 'render', 'binding-access', 'action', 'failure-action', 'persistence', 'failure-binding-missing'] as const;
type LegName = (typeof LEGS)[number];
type Leg = { status: 'PASS' | 'FAIL' | 'NOT RUN'; commands: string[]; asserted: string[]; failure?: string };
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const HOLD = [
	'workers.dev smoke deploy on Workers Free: Cloudflare stays pinned (no account, no deploy)',
	'numeric cold and warm staging budgets: need real Workers on Workers Paid',
	'remote D1 and R2: only local Miniflare-backed bindings ran',
];

class Refusal extends Error {}

const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
const BUN = pkg.packageManager.replace(/^bun@/, '');

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HERE, env: opts.env ?? {}, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function git(...args: string[]): string {
	const r = run('git', args, { env: { PATH: '/usr/bin:/bin' } });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
}

const repo = () => git('rev-parse', '--show-toplevel');
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all');

/** [commands, asserted] each leg writes; a leg that gains or loses one changes this table, or `evidence` stays false. */
const LEG_SHAPE: Record<LegName, [number, number]> = {
	build: [1, 4],
	request: [2, 10],
	render: [1, 3],
	'binding-access': [1, 3],
	action: [2, 4],
	'failure-action': [4, 5],
	persistence: [3, 4],
	'failure-binding-missing': [5, 6],
};
/** The keys of the environment every child gets (the spike's allowlist), sorted. */
const ENV_KEYS = ['CI', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'HOME', 'PATH', 'WRANGLER_HIDE_BANNER', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_SEND_METRICS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];

/** A literal is deep-equal; a RegExp matches a string; a function is a predicate; an array has exactly its length; an object exactly its keys. */
type Spec = null | boolean | string | RegExp | ((v: unknown) => boolean) | Spec[] | { [key: string]: Spec };
const NONEMPTY = (v: unknown) => typeof v === 'string' && v.length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The one expected shape of a PASS summary for `sha`: every field, its type and its value. */
function expectedShape(sha: string, summary: Record<string, unknown>): Spec {
	const node = isObject(summary.hosts) && typeof summary.hosts.node === 'string' ? summary.hosts.node : '';
	const workerd = pkg.devDependencies.workerd!;
	return {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: true,
		servedStamp: sha,
		startedAt: ISO,
		finishedAt: ISO,
		runDir: /^\.local\/hosting-probe\/runtime\/[0-9A-Za-z-]+$/,
		hosts: { bun: BUN, node: /^\d+\.\d+\.\d+$/, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node}`, app: `workerd ${workerd} (native)` },
		pins: { ...pkg.devDependencies },
		artifact: /^sha256:[0-9a-f]{64}$/,
		isolation: { network: /^own network namespace: interfaces \[lo\], 0 IPv4 routes, 0 IPv6 routes; /, env: ENV_KEYS },
		legs: Object.fromEntries(LEGS.map((name) => [name, { status: 'PASS', commands: Array.from({ length: LEG_SHAPE[name][0] }, () => NONEMPTY), asserted: Array.from({ length: LEG_SHAPE[name][1] }, () => NONEMPTY) }])),
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
function checkSummary(summary: unknown, sha: string): string[] {
	if (!isObject(summary)) return ['summary is not an object'];
	const problems: string[] = [];
	conform(summary, expectedShape(sha, summary), 'summary', problems);
	return problems;
}

/** Every leaf and container of the real summary, deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown key added to each object; the count refused, or the first accepted. */
function mutationsRefused(summary: Record<string, unknown>, sha: string): { refused: number; accepted: string | null } {
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
		const [node, bun] = JSON.parse(r.out) as [string, string | null];
		if (bun === null) return { path: candidate, version: node };
	}
	throw new Refusal('no real Node on PATH (Wrangler needs Node >= 22; `node` under `bun run --bun` is Bun)');
}

/** Installed versions must equal the pins: a stale node_modules is not the pinned toolchain. */
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

/** The network namespace has loopback only and no route off the host; offline.sh checked it, this proves it again. */
function checkOffline(): string {
	const links = (JSON.parse(run('ip', ['-j', 'addr'], { env: { PATH: '/usr/bin:/bin' } }).out) as { ifname: string }[]).map((l) => l.ifname);
	const routes4 = JSON.parse(run('ip', ['-4', '-j', 'route'], { env: { PATH: '/usr/bin:/bin' } }).out) as unknown[];
	const routes6 = JSON.parse(run('ip', ['-6', '-j', 'route'], { env: { PATH: '/usr/bin:/bin' } }).out) as unknown[];
	if (links.join() !== 'lo' || routes4.length || routes6.length) throw new Refusal(`not offline: interfaces ${links.join(',')}, ${routes4.length} IPv4 and ${routes6.length} IPv6 routes`);
	return 'own network namespace: interfaces [lo], 0 IPv4 routes, 0 IPv6 routes; host resolver sockets hidden';
}

/** sha256 over every file of the Worker bundle (relative path and bytes), in path order. */
function artifactDigest(): string {
	const h = createHash('sha256');
	for (const root of ['.svelte-kit/cloudflare', '.svelte-kit/output/server']) {
		const files = readdirSync(path.join(HERE, root), { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => path.relative(HERE, path.join(e.parentPath, e.name)))
			.sort();
		for (const f of files) h.update(`${f}\0`).update(readFileSync(path.join(HERE, f))).update('\0');
	}
	return `sha256:${h.digest('hex')}`;
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

type Server = { child: ChildProcess; tree: Proc[]; label: string };
const live = new Set<Server>();

async function startServer(node: string, env: Record<string, string>, persist: string, logs: string, label: string, extra: string[]): Promise<Server> {
	const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false', ...extra];
	const child = spawn(node, args, { cwd: HERE, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	const server: Server = { child, tree: [], label };
	live.add(server);
	const log = createWriteStream(path.join(logs, `wrangler-${label}.log`));
	let text = '';
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: no "Ready on" within 45 s`)), 45_000);
		const onData = (b: Buffer) => {
			log.write(b);
			text += b.toString();
			if (text.includes('Ready on')) (clearTimeout(timer), resolve());
		};
		child.stdout!.on('data', onData);
		child.stderr!.on('data', onData);
		child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${label}: Wrangler exited ${code} before Ready: ${text.slice(-1500)}`))));
	});
	await ready;
	server.tree = descendants(child.pid!);
	return server;
}

/** SIGINT to the server's process group, then SIGTERM and SIGKILL; refuses if any process of its tree survives. Returns the last signal sent, the one that ended the tree (null if it was already gone). */
async function stopServer(server: Server): Promise<'SIGINT' | 'SIGTERM' | 'SIGKILL' | null> {
	const { child } = server;
	const pgid = child.pid!;
	// workerd can outlive Wrangler by a moment, so wait for the whole tree, not only Wrangler, before escalating
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

async function http(pathname: string, init: RequestInit = {}) {
	const res = await fetch(BASE + pathname, { redirect: 'manual', ...init, signal: AbortSignal.timeout(15_000) });
	return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

const post = (form: Record<string, string>, origin = BASE) =>
	http('/?/save', { method: 'POST', headers: { accept: 'text/html', origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

async function main(out: string): Promise<number> {
	const root = repo();
	const sha = head();
	if (dirty()) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
	rmSync(out, { force: true }); // after every refusal, so a refused run deletes nothing; a stale summary must never stand in for this run's
	const runDir = path.join(root, '.local', 'hosting-probe', 'runtime', new Date().toISOString().replace(/[:.]/g, '-'));
	const rel = (p: string) => p.replace(runDir, '<run>');
	const logs = path.join(runDir, 'logs');
	for (const d of ['home/.config', 'cache', 'logs/wrangler', 'persist/main', 'persist/missing']) mkdirSync(path.join(runDir, d), { recursive: true });
	// The spike's allowlist (spikes/local-workerd-20261017): telemetry, error reports, the update banner, the cf.json
	// fetch and every dotenv/process-env import off; a fresh HOME and XDG dirs, so no cached login can be found.
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
	const wrangler = (...args: string[]) => {
		const r = run(node.path, ['node_modules/wrangler/bin/wrangler.js', ...args], { env });
		writeFileSync(path.join(logs, `wrangler-cli-${args[0]}-${args[1]}-${Date.now()}.log`), r.out);
		return r;
	};
	const legs = Object.fromEntries(LEGS.map((n) => [n, { status: 'NOT RUN', commands: [], asserted: [] } as Leg])) as Record<LegName, Leg>;
	const startedAt = new Date().toISOString();
	let servedStamp: string | null = null;
	let workerd: string | null = null;
	let artifact: string | null = null;
	const mainState = path.join(runDir, 'persist/main');
	const serve = (label: string, persist: string, extra: string[] = []) => startServer(node.path, env, persist, logs, label, extra);
	const serveCmd = (persist: string, extra: string[] = []) => `node node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port ${PORT} --inspector-ip 127.0.0.1 --inspector-port 0 --persist-to ${rel(persist)} --show-interactive-dev-session=false${extra.map((a) => ` ${a}`).join('')}`;

	async function leg(name: LegName, commands: string[], body: (check: (ok: boolean, what: string) => void) => Promise<void>) {
		const l: Leg = { status: 'FAIL', commands, asserted: [] };
		legs[name] = l;
		try {
			await body((ok, what) => {
				if (!ok) throw new Error(`assertion failed: ${what}`);
				l.asserted.push(what);
			});
			l.status = 'PASS';
		} catch (e) {
			l.failure = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	let failure: string | null = null;
	try {
		await leg('build', ['bun run --bun build (PROBE_SOURCE_REVISION=HEAD)'], async (check) => {
			rmSync(path.join(HERE, '.svelte-kit'), { recursive: true, force: true });
			const r = run(process.execPath, ['run', '--bun', 'build'], { env: { ...env, PROBE_SOURCE_REVISION: sha } });
			writeFileSync(path.join(logs, 'build.log'), r.out);
			check(r.code === 0, 'vite build with adapter-cloudflare exits 0, offline');
			check(r.out.includes(`[probe build host] {"bun":"${BUN}"`), `the build ran under Bun ${BUN}`);
			check(existsSync(path.join(HERE, '.svelte-kit/cloudflare/_worker.js')), 'the Worker entry .svelte-kit/cloudflare/_worker.js exists');
			const stamp = JSON.parse(readFileSync(path.join(HERE, '.svelte-kit/cloudflare/_app/version.json'), 'utf8')) as { version?: unknown };
			check(stamp.version === sha, 'the build is stamped with HEAD (_app/version.json)');
			artifact = artifactDigest();
		});

		let server: Server | null = null;
		await leg('request', [`node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --persist-to ${rel(mainState)} --file schema.sql`, serveCmd(mainState)], async (check) => {
			const schema = wrangler('d1', 'execute', 'DB', '--local', '--persist-to', mainState, '--file', 'schema.sql');
			check(schema.code === 0, 'wrangler d1 execute --local applies schema.sql in its own process, exit 0');
			server = await serve('main', mainState);
			check(true, 'Wrangler (hosted by Node) prints Ready within 45 s');
			const host = server.tree.find((p) => p.pid === server!.child.pid);
			check(!!host && host.exe.startsWith('node'), `Wrangler's process is Node (${host?.exe})`);
			check(server.tree.some((p) => p.exe === 'workerd'), 'a native workerd process serves the app, a descendant of Wrangler');
			const versions = run(path.join(HERE, 'node_modules/workerd/bin/workerd'), ['--version']);
			check(versions.code === 0 && versions.out.startsWith('workerd '), `the installed workerd binary runs and reports "${versions.out.trim()}"`);
			workerd = pins.workerd!;
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.status === 200 && page.type.startsWith('text/html'), 'GET / answers 200 text/html');
			check(page.body.includes('<h1>ClearCase runtime probe</h1>'), 'GET / is the SSR page');
			const asset = await http('/probe.txt');
			check(asset.status === 200 && asset.body === readFileSync(path.join(HERE, 'static/probe.txt'), 'utf8'), 'GET /probe.txt serves the static asset byte for byte through ASSETS');
			const version = await http('/_app/version.json');
			servedStamp = (JSON.parse(version.body) as { version?: string }).version ?? null;
			check(version.status === 200 && servedStamp === sha, 'GET /_app/version.json serves the HEAD stamp');
			const missing = await http('/no-such-page', { headers: { accept: 'text/html' } });
			check(missing.status === 404 && missing.type.startsWith('text/html') && missing.body.includes('Not Found'), 'GET /no-such-page answers 404 text/html with the "Not Found" error page');
		});

		await leg('render', ['GET / (Accept: text/html)'], async (check) => {
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.status === 200, 'GET / answers 200');
			check(page.body.includes('D1 notes: 1') && page.body.includes('seed-1: synthetic seed note'), 'SSR renders the D1 row the CLI inserted');
			check(page.body.includes('R2 latest: empty'), 'SSR reads R2: no object yet');
		});

		await leg('binding-access', ['GET /bindings'], async (check) => {
			const res = await http('/bindings');
			const b = JSON.parse(res.body) as Record<string, unknown>;
			check(res.status === 200 && res.type.startsWith('application/json'), 'GET /bindings answers 200 JSON');
			check(b.DB === true && b.BUCKET === true && b.ASSETS === true, 'the Worker sees DB (D1 prepare), BUCKET (R2 put) and ASSETS (fetch)');
			check(b.notes === 1, 'D1 answers SELECT COUNT(*) FROM notes through the binding: 1');
		});

		const A = 'synthetic probe body A';
		await leg('action', ['POST /?/save id=probe-1 (Accept: text/html, same Origin)', 'GET /'], async (check) => {
			const res = await post({ id: 'probe-1', body: A });
			check(res.status === 200, 'the form action answers 200');
			check(res.body.includes(`Saved probe-1; R2 read back: ${A}`), 'the action wrote D1, then put the R2 object and read it back');
			check(res.body.includes('D1 notes: 2') && res.body.includes(`R2 latest: ${A}`), 'the page after the action shows the new D1 row and R2 object');
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.body.includes(`probe-1: ${A}`) && page.body.includes(`R2 latest: ${A}`), 'a fresh GET / reads both writes back');
		});

		await leg('failure-action', ['POST /?/save id= body=', 'POST /?/save id=probe-1 (again)', 'POST /?/save with a foreign Origin', 'GET /'], async (check) => {
			const empty = await post({ id: '', body: '' });
			check(empty.status === 400 && empty.body.includes('id and body are required'), 'an empty form answers 400 with the validation message');
			const dup = await post({ id: 'probe-1', body: 'synthetic probe body B' });
			check(dup.status === 409 && dup.body.includes('note probe-1 already exists'), 'a duplicate id answers 409: D1 refused the INSERT (UNIQUE)');
			const cross = await post({ id: 'probe-2', body: 'synthetic probe body C' }, 'http://foreign.invalid');
			check(cross.status === 403 && cross.body.includes('Cross-site POST form submissions are forbidden') && !cross.body.includes('Saved'), "a cross-site form POST answers 403 with SvelteKit's Origin-check message and runs no action");
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.body.includes('D1 notes: 2') && !page.body.includes('probe-2'), 'D1 holds no row from the refused actions');
			check(page.body.includes(`R2 latest: ${A}`) && !page.body.includes('body B') && !page.body.includes('body C'), 'R2 still holds the last good write');
		});

		await leg('persistence', [`node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --persist-to ${rel(mainState)} --json --command "SELECT id, body FROM notes ORDER BY id"`, serveCmd(mainState), 'GET /'], async (check) => {
			const ended = await stopServer(server!);
			check(ended === 'SIGINT' || ended === 'SIGTERM', `the server's process tree ended on ${ended} without SIGKILL, and no process of it survived`);
			const read = wrangler('d1', 'execute', 'DB', '--local', '--persist-to', mainState, '--json', '--command', 'SELECT id, body FROM notes ORDER BY id');
			const rows = read.code === 0 ? ((JSON.parse(read.out.slice(read.out.indexOf('['))) as { results: { id: string; body: string }[] }[])[0]?.results ?? []) : [];
			check(JSON.stringify(rows) === JSON.stringify([{ id: 'probe-1', body: A }, { id: 'seed-1', body: 'synthetic seed note' }]), 'a separate wrangler d1 execute reads both rows from the stopped server\'s state');
			server = await serve('restart', mainState);
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.status === 200 && page.body.includes('D1 notes: 2') && page.body.includes(`probe-1: ${A}`), 'after a restart SSR renders the persisted D1 rows');
			check(page.body.includes(`R2 latest: ${A}`), 'after a restart, before any write, R2 returns the persisted object');
			await stopServer(server);
			server = null;
		});

		const missing = path.join(runDir, 'persist/missing');
		await leg('failure-binding-missing', [`node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --env missing-binding --persist-to ${rel(missing)} --file schema.sql`, serveCmd(missing, ['--env', 'missing-binding']), 'GET /', 'POST /?/save', 'GET /bindings'], async (check) => {
			const schema = wrangler('d1', 'execute', 'DB', '--local', '--env', 'missing-binding', '--persist-to', missing, '--file', 'schema.sql');
			check(schema.code === 0, 'the same Worker without its R2 binding (--env missing-binding) gets D1 and its schema');
			server = await serve('missing-binding', missing, ['--env', 'missing-binding']);
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.status === 503 && page.body.includes('BUCKET binding is not configured'), 'GET / answers 503 naming the missing BUCKET binding');
			check(!page.body.includes('R2 latest') && !page.body.includes('D1 notes'), 'no partial page is rendered');
			const res = await post({ id: 'probe-3', body: 'synthetic probe body D' });
			check(res.status === 503 && res.body.includes('BUCKET binding is not configured'), 'the form action answers 503 naming the missing binding');
			const bindings = await http('/bindings');
			check(bindings.status === 200 && bindings.type.startsWith('application/json'), 'GET /bindings answers 200 JSON');
			const b = JSON.parse(bindings.body) as Record<string, unknown>;
			check(b.DB === true && b.BUCKET === false && b.ASSETS === true && b.notes === 1, 'GET /bindings: DB (answering) and ASSETS present, BUCKET absent');
			await stopServer(server);
			server = null;
		});
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	} finally {
		for (const s of [...live]) await stopServer(s).catch((e: unknown) => (failure ??= String(e)));
	}

	const endSha = head();
	const clean = !dirty();
	const summary: Record<string, unknown> = {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: clean && endSha === sha,
		servedStamp,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: process.versions.bun, node: node.version, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node.version}`, app: `workerd ${workerd} (native)` },
		pins,
		artifact,
		isolation: { network: isolation, env: Object.keys(env).sort() },
		legs,
		hold: HOLD,
		failure,
		evidence: false,
	};
	const draft = { ...summary, evidence: true, checker: { mutationsRefused: 1, accepted: null } };
	if (failure === null && clean && endSha === sha && checkSummary(draft, sha).length === 0) {
		const m = mutationsRefused(draft, sha);
		summary.checker = { mutationsRefused: m.refused, accepted: m.accepted };
		summary.evidence = m.accepted === null && checkSummary({ ...summary, evidence: true }, sha).length === 0;
	}
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	for (const name of LEGS) console.log(`${legs[name].status.padEnd(7)} ${name}${legs[name].failure ? `: ${legs[name].failure}` : ''}`);
	if (!clean || endSha !== sha) console.log(`FAIL    tree changed during the run (HEAD ${endSha.slice(0, 12)}, clean ${clean})`);
	console.log(`${summary.evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} evidence: ${summary.evidence} summary: ${path.relative(root, out)}`);
	return summary.evidence ? 0 : 1;
}

/** Re-runs this file inside tests/e2e/pilot/offline.sh: no network but loopback, the host resolver hidden. */
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

const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'string' }, inside: { type: 'boolean' } } });
try {
	if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
	if (values.check) {
		const problems = checkSummary(JSON.parse(readFileSync(values.check, 'utf8')), head());
		for (const p of problems) console.log(`refused: ${p}`);
		console.log(problems.length ? `CHECK FAIL ${values.check}` : `CHECK PASS ${values.check}`);
		process.exit(problems.length ? 1 : 0);
	}
	const out = path.resolve(values.out ?? path.join(repo(), '.local/hosting-probe/runtime/summary.json'));
	if (!values.inside) process.exit(enterOffline(['--out', out]));
	if (process.env.CLEARCASE_OFFLINE !== '1') throw new Refusal('--inside runs only under tests/e2e/pilot/offline.sh');
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		process.once(signal, () => void Promise.allSettled([...live].map(stopServer)).then(() => process.exit(130)));
	process.exit(await main(out));
} catch (e) {
	if (!(e instanceof Refusal)) throw e;
	console.error(`PROBE REFUSED: ${e.message}`);
	process.exit(2);
}
