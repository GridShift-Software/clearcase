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
// `--check FILE` refuses (exit 1) a summary that is not this runner's PASS for HEAD: a missing, null or retyped field
// fails, as does any leg that is not PASS.
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

/** Every problem that keeps `summary` from being this runner's evidence for `sha`; empty means it is. */
function checkSummary(summary: unknown, sha: string): string[] {
	const s = summary as Record<string, unknown> | null;
	if (typeof s !== 'object' || s === null || Array.isArray(s)) return ['summary is not an object'];
	const problems: string[] = [];
	const str = (v: unknown) => typeof v === 'string' && v.length > 0;
	if (s.schema !== SCHEMA) problems.push(`schema is not ${SCHEMA}`);
	if (s.sourceSha !== sha) problems.push(`sourceSha ${JSON.stringify(s.sourceSha)} is not HEAD ${sha}`);
	if (s.treeClean !== true) problems.push('treeClean is not true');
	if (s.servedStamp !== sha) problems.push(`servedStamp ${JSON.stringify(s.servedStamp)} is not HEAD ${sha}`);
	if (s.evidence !== true) problems.push('evidence is not true');
	if (s.failure !== null) problems.push('failure is not null');
	if (typeof s.artifact !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(s.artifact)) problems.push('artifact is not a sha256 digest');
	const hosts = s.hosts as Record<string, unknown> | null;
	if (typeof hosts !== 'object' || hosts === null) problems.push('hosts is not an object');
	else {
		if (hosts.bun !== BUN) problems.push(`hosts.bun is not ${BUN}`);
		for (const k of ['node', 'workerd'] as const) if (!str(hosts[k])) problems.push(`hosts.${k} is not a version`);
	}
	const pins = s.pins as Record<string, unknown> | null;
	if (typeof pins !== 'object' || pins === null) problems.push('pins is not an object');
	else for (const [name, version] of Object.entries(pkg.devDependencies)) if (pins[name] !== version) problems.push(`pins.${name} is not ${version}`);
	const legs = s.legs as Record<string, unknown> | null;
	if (typeof legs !== 'object' || legs === null) problems.push('legs is not an object');
	else {
		const extra = Object.keys(legs).filter((k) => !(LEGS as readonly string[]).includes(k));
		if (extra.length) problems.push(`unknown legs ${extra.join(', ')}`);
		for (const name of LEGS) {
			const leg = legs[name] as Record<string, unknown> | null;
			if (typeof leg !== 'object' || leg === null) problems.push(`leg ${name} is missing`);
			else if (leg.status !== 'PASS') problems.push(`leg ${name} is ${JSON.stringify(leg.status)}, not PASS`);
			else if (!Array.isArray(leg.asserted) || leg.asserted.length === 0 || !leg.asserted.every(str)) problems.push(`leg ${name} asserted nothing`);
		}
	}
	return problems;
}

/** Fields whose deletion, null or retyping must each make `checkSummary` refuse; the count of mutations refused, or the first one accepted. */
function mutationsRefused(summary: Record<string, unknown>, sha: string): { refused: number; accepted: string | null } {
	const paths: string[][] = [['schema'], ['sourceSha'], ['treeClean'], ['servedStamp'], ['evidence'], ['failure'], ['artifact'], ['hosts'], ['hosts', 'bun'], ['hosts', 'node'], ['hosts', 'workerd'], ['pins'], ['legs']];
	for (const name of Object.keys(pkg.devDependencies)) paths.push(['pins', name]);
	for (const name of LEGS) paths.push(['legs', name], ['legs', name, 'status'], ['legs', name, 'asserted']);
	let refused = 0;
	for (const p of paths) {
		for (const [label, mutate] of [
			['deleted', (o: Record<string, unknown>, k: string) => delete o[k]],
			['null', (o: Record<string, unknown>, k: string) => (o[k] = null)],
			['retyped', (o: Record<string, unknown>, k: string) => (o[k] = typeof o[k] === 'string' ? 1 : String(o[k]))],
		] as const) {
			const copy = structuredClone(summary);
			const parent = p.slice(0, -1).reduce((o, k) => o[k] as Record<string, unknown>, copy);
			if (label === 'null' && parent[p.at(-1)!] === null) continue; // already null: not a mutation
			mutate(parent, p.at(-1)!);
			if (checkSummary(copy, sha).length === 0) return { refused, accepted: `${p.join('.')} ${label}` };
			refused++;
		}
	}
	return { refused, accepted: null };
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

/** SIGINT to the server's process group, then SIGTERM and SIGKILL; refuses if any process of its tree survives. */
async function stopServer(server: Server): Promise<void> {
	const { child } = server;
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	const wait = (ms: number) => new Promise<boolean>((resolve) => {
		if (exited()) return resolve(true);
		const t = setTimeout(() => resolve(exited()), ms);
		child.once('exit', () => (clearTimeout(t), resolve(true)));
	});
	for (const [signal, ms] of [['SIGINT', 12_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (exited()) break;
		try {
			process.kill(-child.pid!, signal);
		} catch {}
		await wait(ms);
	}
	live.delete(server);
	const pgid = child.pid!;
	const left = [...processes().values()].filter((p) => p.pgrp === pgid || server.tree.some((t) => t.pid === p.pid && t.exe === p.exe));
	if (left.length) throw new Error(`${server.label}: processes survived the stop: ${left.map((p) => `${p.pid} ${p.exe}`).join(', ')}`);
}

async function http(pathname: string, init: RequestInit = {}) {
	const res = await fetch(BASE + pathname, { redirect: 'manual', ...init, signal: AbortSignal.timeout(15_000) });
	return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

const post = (form: Record<string, string>, origin = BASE) =>
	http('/?/save', { method: 'POST', headers: { accept: 'text/html', origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

async function main(out: string): Promise<number> {
	if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
	const root = repo();
	rmSync(out, { force: true }); // a stale summary must never stand in for this run's
	const sha = head();
	if (dirty()) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
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
			check(missing.status === 404, 'GET /no-such-page answers 404');
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
			check(cross.status === 403 && !cross.body.includes('Saved'), 'a cross-site form POST answers 403 (SvelteKit Origin check) and runs no action');
			const page = await http('/', { headers: { accept: 'text/html' } });
			check(page.body.includes('D1 notes: 2') && !page.body.includes('probe-2'), 'D1 holds no row from the refused actions');
			check(page.body.includes(`R2 latest: ${A}`) && !page.body.includes('body B') && !page.body.includes('body C'), 'R2 still holds the last good write');
		});

		await leg('persistence', [`node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --persist-to ${rel(mainState)} --json --command "SELECT id, body FROM notes ORDER BY id"`, serveCmd(mainState), 'GET /'], async (check) => {
			await stopServer(server!);
			check(true, 'the server stopped on SIGINT and no process of its tree survived');
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
			const b = JSON.parse((await http('/bindings')).body) as Record<string, unknown>;
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
	summary.evidence = failure === null && clean && endSha === sha && checkSummary({ ...summary, evidence: true }, sha).length === 0;
	if (summary.evidence) {
		const m = mutationsRefused(summary, sha);
		summary.checker = { mutationsRefused: m.refused, accepted: m.accepted };
		if (m.accepted) summary.evidence = false;
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
