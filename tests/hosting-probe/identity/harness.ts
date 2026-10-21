// What the identity probe's runner (probe.ts) and its offline tests (crafted.ts) share (GRS-108): the pinned build, the
// local D1 and R2 seed, and serve.mjs, the Node host that runs both Workers on native workerd through Wrangler's
// startWorker. serve.mjs gets its keys over a pipe on fd 3 (the protocol of deploy/probes/secrets.ts: it is started
// with the reader's own fd preload and reads them with takeSecrets()), never through its environment, argv or a file,
// and passes them to workerd inside the Worker config.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { FD_PRELOAD } from '../../../deploy/probes/secrets.ts';

export const HERE = import.meta.dirname;
export const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
export const BUN = pkg.packageManager.replace(/^bun@/, '');

export class Refusal extends Error {}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HERE, env: opts.env ?? {}, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 240_000 });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

/** The first `node` on PATH that is really Node, not Bun's `bun run --bun` stand-in; Wrangler hangs under Bun. */
export function realNode(): { path: string; version: string } {
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
export function checkInstalled(): Record<string, string> {
	const wrong: string[] = [];
	for (const [name, pin] of Object.entries(pkg.devDependencies)) {
		const file = path.join(HERE, 'node_modules', name, 'package.json');
		const installed = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version : 'missing';
		if (installed !== pin) wrong.push(`${name} ${installed} (pin ${pin})`);
	}
	if (wrong.length) throw new Refusal(`installed packages differ from the pins: ${wrong.join(', ')}; run bun install --frozen-lockfile here`);
	return { ...pkg.devDependencies };
}

/** The environment every Wrangler child gets (GRS-106's allowlist): telemetry, error reports, the banner, the cf.json fetch and every dotenv or process-env import off, and a fresh HOME, so no cached login can be found. */
export function appEnv(node: { path: string }, runDir: string): Record<string, string> {
	for (const d of ['home/.config', 'cache', 'logs/wrangler']) mkdirSync(path.join(runDir, d), { recursive: true });
	return {
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
}

/** Builds the probe app with Bun (`bun`, this process's own by default) for adapter-cloudflare, stamped with `revision`; throws with the log's tail on failure. */
export function build(node: { path: string }, runDir: string, revision: string, bun = process.execPath): string {
	const r = run(bun, ['run', '--bun', 'build'], { env: { ...appEnv(node, runDir), PROBE_SOURCE_REVISION: revision } });
	writeFileSync(path.join(runDir, 'logs', 'build.log'), r.out);
	if (r.code !== 0) throw new Error(`build failed (exit ${r.code}): ${r.out.slice(-1200)}`);
	if (!existsSync(path.join(HERE, '.svelte-kit/cloudflare/_worker.js'))) throw new Error('build wrote no .svelte-kit/cloudflare/_worker.js');
	return r.out;
}

export const wranglerArgs = (args: string[]) => [path.join(HERE, 'node_modules/wrangler/bin/wrangler.js'), ...args];

/**
 * Where `app`'s local D1 and R2 live under a world's `persist` root. Each Worker has a directory of its own because each
 * runs in its own workerd: two workerds on one directory hold the same SQLite files (every namespace's metadata.sqlite,
 * the observability store), and when their starts overlap on a loaded machine one dies with SQLITE_BUSY.
 */
export const persistOf = (persist: string, app: 'client' | 'staff') => path.join(persist, app);

/** Applies each app's SQL files to its local D1 and puts every file under fixtures/r2/<app>/ into its local R2, through the Wrangler CLI (a separate process from the Workers). */
export function seed(node: { path: string }, env: Record<string, string>, persist: string, logs: string, sql: Record<'client' | 'staff', string[]>): string[] {
	const commands: string[] = [];
	const cli = (label: string, args: string[]) => {
		const r = run(node.path, wranglerArgs(args), { env });
		writeFileSync(path.join(logs, `seed-${label}.log`), r.out);
		commands.push(`wrangler ${args.map((a) => a.replace(persist, '<persist>')).join(' ')}`);
		if (r.code !== 0) throw new Error(`seed ${label} failed (exit ${r.code}): ${r.out.slice(-800)}`);
	};
	for (const app of ['client', 'staff'] as const) {
		sql[app].forEach((file, i) => cli(`${app}-d1-${i}`, ['d1', 'execute', 'DB', '--local', '--env', app, '--persist-to', persistOf(persist, app), '--file', file]));
		const root = path.join(HERE, 'fixtures', 'r2', app);
		if (!existsSync(root)) continue;
		const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name))).sort();
		files.forEach((key, i) => cli(`${app}-r2-${i}`, ['r2', 'object', 'put', `probe-identity-${app}/${key}`, '--local', '--env', app, '--persist-to', persistOf(persist, app), '--file', path.join(root, key)]));
	}
	return commands;
}

export type ServeConfig = {
	/** The world's store root: each app's state is under persistOf(persist, app). */
	persist: string;
	logs: string;
	/** Clerk's Backend API base; the offline tests point it at their loopback status endpoint. */
	apiUrl?: string;
	mfaRequired: boolean;
	/** True when fd 3 also carries CLIENT_A_JWT_KEY and STAFF_JWT_KEY (the crafted issuers' public keys). */
	jwtKeys: boolean;
	client: { port: number; origin: string };
	staff: { port: number; origin: string };
};

/** What serve.mjs receives as argv[2]: the config with each app's own store directory (persistOf) added to the app. */
export type ServeArgs = Omit<ServeConfig, 'client' | 'staff'> & { client: ServeConfig['client'] & { persist: string }; staff: ServeConfig['staff'] & { persist: string } };

/** `n` distinct free loopback ports (all held open together, then released), so two worktrees or two runs never share one. */
export async function freePorts(n: number): Promise<number[]> {
	const servers = await Promise.all(Array.from({ length: n }, () => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
		const s = createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => resolve(s));
	})));
	const ports = servers.map((s) => (s.address() as { port: number }).port);
	await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
	return ports;
}

// serve.mjs is a process group of its own (so stopServe can signal the group), which nothing would stop with its runner.
// Three things do: serve.mjs ends when its stdin, a pipe from the runner, ends (any way the runner dies, SIGKILL included);
// the runner's exit event signals every live group; and a SIGINT, SIGTERM or SIGHUP runs the registered interrupt hooks (the
// live probe's Clerk cleanup, which first halts the step that was running), then stops every live group and exits 128 + the
// signal.
const live = new Set<ChildProcess>();
const hooks = new Set<() => Promise<void>>();
let armed = false;
function arm(): void {
	if (armed) return;
	armed = true;
	process.on('exit', () => {
		for (const c of live) try { process.kill(-c.pid!, 'SIGTERM'); } catch {}
	});
	let first = 0;
	for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
		process.on(signal, () => {
			// Ctrl-C reaches the runner from the terminal and again from its launchers' forwarding, within milliseconds; a signal
			// that comes well after the first, while it is still cleaning up, means "now"
			if (first) return void (Date.now() - first > 3_000 && process.exit(code));
			first = Date.now();
			void (async () => {
				for (const hook of [...hooks]) await hook().catch(() => {});
				await Promise.all([...live].map((c) => stopServe(c).catch(() => {})));
				process.exit(code);
			})();
		});
	}
}
/** Runs `hook` on SIGINT, SIGTERM or SIGHUP, before the live serve.mjs groups are stopped and the process exits; returns its unregister. */
export function onInterrupt(hook: () => Promise<void>): () => void {
	arm();
	hooks.add(hook);
	return () => void hooks.delete(hook);
}

/** Starts serve.mjs with `secrets` on fd 3 and resolves once both Workers are live; the child's output goes to logs/serve-<n>.log. */
export async function startServe(node: { path: string }, env: Record<string, string>, config: ServeConfig, secrets: Map<string, string>, logs: string): Promise<ChildProcess> {
	const n = readdirSync(logs).filter((f) => f.startsWith('serve-')).length;
	const log = createWriteStream(path.join(logs, `serve-${n}.log`));
	const args: ServeArgs = { ...config, client: { ...config.client, persist: persistOf(config.persist, 'client') }, staff: { ...config.staff, persist: persistOf(config.persist, 'staff') } };
	// the reader's own fd preload takes the keys off fd 3 and closes it before serve.mjs imports Wrangler: one protocol for handing keys over
	const child = spawn(node.path, [`--import=${FD_PRELOAD}`, path.join(HERE, 'serve.mjs'), JSON.stringify(args)], { cwd: HERE, env: { ...env, WRANGLER_LOG: 'warn', CLEARCASE_SECRETS_FD: '3' }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
	arm();
	live.add(child);
	child.once('exit', () => live.delete(child));
	child.stdin!.on('error', () => {}); // serve.mjs stops when this pipe ends; it is never written
	const pipe = child.stdio[3] as NodeJS.WritableStream;
	pipe.on('error', () => {});
	pipe.end([...secrets].map(([k, v]) => `${k}=${v}\n`).join(''));
	let text = '';
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`serve.mjs: not ready within 90 s: ${text.slice(-1500)}`)), 90_000);
			const onData = (b: Buffer) => {
				log.write(b);
				text += b.toString();
				if (text.includes('serve: ready')) (clearTimeout(timer), resolve());
			};
			child.stdout!.on('data', onData);
			child.stderr!.on('data', onData);
			child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`serve.mjs exited ${code} before it was ready: ${text.slice(-1500)}`))));
		});
	} catch (e) {
		await stopServe(child).catch(() => {});
		throw e;
	}
	return child;
}

/** SIGINT to serve.mjs's process group, then SIGTERM and SIGKILL; resolves with the signal that ended it. */
export async function stopServe(child: ChildProcess): Promise<'SIGINT' | 'SIGTERM' | 'SIGKILL' | null> {
	const done = () => child.exitCode !== null || child.signalCode !== null;
	let ended: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | null = null;
	for (const [signal, ms] of [['SIGINT', 15_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (done()) break;
		ended = signal;
		try {
			process.kill(-child.pid!, signal);
		} catch {}
		for (const until = Date.now() + ms; Date.now() < until && !done(); ) await new Promise((r) => setTimeout(r, 100));
	}
	// workerd can outlive its host by a moment; the group must be empty before the next start takes the ports
	for (const until = Date.now() + 5_000; Date.now() < until; ) {
		try {
			process.kill(-child.pid!, 0);
		} catch {
			return ended;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`serve.mjs (pid ${child.pid}): its process group survived SIGKILL`);
}

export type Reply = { status: number; type: string; body: string; location: string | null; headers: Headers; denial: string | null; clerkReason: string | null };

/** One request to a probe Worker: `token` goes in Authorization, `cookies` in Cookie; redirects are not followed. */
export async function fetchApp(origin: string, pathname: string, init: RequestInit & { token?: string; cookies?: Record<string, string> } = {}): Promise<Reply> {
	const { token, cookies, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (cookies) headers.set('cookie', Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '));
	if (rest.method && rest.method !== 'GET' && !headers.has('origin')) headers.set('origin', origin);
	const res = await fetch(origin + pathname, { redirect: 'manual', ...rest, headers, signal: AbortSignal.timeout(30_000) });
	return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), location: res.headers.get('location'), headers: res.headers, denial: res.headers.get('x-probe-denial'), clerkReason: res.headers.get('x-probe-clerk-reason') };
}
