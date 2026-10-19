// The hosted artifact on local workerd (GRS-112): build it, serve it, test it. From the repository root:
//
//   bun run --bun build:hosted          the Workers artifact (.svelte-kit/cloudflare), stamped with HEAD
//   bun run --bun start:hosted          serve it on workerd through `wrangler dev --local`, with local D1 and R2
//   bun run --bun start:hosted --stop   stop the server this worktree started on PORT
//   bun run --bun test:hosted           smoke-test the running artifact and run the import-boundary negative test
//
// Env: PORT (41301) for start and test; CLEARCASE_HOSTED_PROFILE=hosted-gate for build only (the default production
// artifact holds no test double; the hosted-gate artifact holds the named doubles GRS-138 drives).
//
// Hosts: Bun 1.4.2 runs this script, the Vite build and every test request. Real Node (the first `node` on PATH that is
// not Bun) hosts Wrangler only, which runs the native workerd binary that serves the artifact. A Node or Bun server pass
// is not hosted evidence; only these workerd runs are.
//
// Offline: Wrangler and every Wrangler CLI call run with GRS-106's environment allowlist (a fresh HOME and XDG dirs, no
// telemetry, error reports, banner, cf.json fetch, dotenv or process-env import) and only `--local` bindings. No
// Cloudflare account, token or login is read or needed. Run state and logs stay under .local/hosted/.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { removePidFile, stopPidFile, writePidFile } from '../pidfile.ts';
import { scanArtifact } from '../ci/hosted-artifact.ts';
import type { HostedProfile } from '../ci/hosted-imports.ts';
import { gateFixture, sentinel } from '../../tests/hosted-foundation/runtime/gate-fixture.ts';
import { smoke } from '../../tests/hosted-foundation/runtime/smoke.ts';

const root = path.resolve(import.meta.dirname, '../..');
const CONFIG = 'deploy/client/wrangler.toml';
const SIDECAR = '.svelte-kit/clearcase-hosted.json';
const BUN = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { packageManager: string }).packageManager.replace(/^bun@/, '');
const port = Number(process.env.PORT ?? 41301);
const base = `http://127.0.0.1:${port}`;
const stateFile = path.join(root, '.local', 'hosted', `server-${port}.json`);
const pidFile = path.join(root, '.local', 'hosted', `start-${port}.pid`);

class Refusal extends Error {}
type Sidecar = { schema: 'clearcase.hosted-build/1'; stamp: { revision: string; dirty: boolean; profile: HostedProfile; buildId: string; builtAt: string; bun: string }; artifact: string };
export type ServerState = { schema: 'clearcase.hosted-server/1'; pid: number; port: number; base: string; revision: string; profile: HostedProfile; artifact: string; runDir: string; persist: string; runId: string; fixtureSha256: string | null; node: string; startedAt: string };

function run(cmd: string, args: string[], env: Record<string, string>, cwd = root) {
	const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}
const git = (...args: string[]) => {
	const r = run('git', args, { PATH: '/usr/bin:/bin' });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
};
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all') !== '';

/** sha256 over every file of the Worker artifact (relative path and bytes), in path order. */
function artifactDigest(): string {
	const h = createHash('sha256');
	for (const dir of ['.svelte-kit/cloudflare', '.svelte-kit/output/server']) {
		const files = readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name))).sort();
		for (const f of files) h.update(`${f}\0`).update(readFileSync(path.join(root, f))).update('\0');
	}
	return `sha256:${h.digest('hex')}`;
}

/** The first `node` on PATH that is really Node, not Bun's `bun run --bun` stand-in; Wrangler needs Node. */
function realNode(): { path: string; version: string } {
	for (const dir of (process.env.PATH ?? '').split(':')) {
		const candidate = path.join(dir, 'node');
		try {
			accessSync(candidate, constants.X_OK);
		} catch {
			continue;
		}
		const r = run(candidate, ['-p', 'JSON.stringify([process.versions.node, process.versions.bun ?? null])'], { PATH: '/usr/bin:/bin' });
		if (r.code !== 0) continue;
		const [node, bun] = JSON.parse(r.out) as [string, string | null];
		if (bun === null) return { path: candidate, version: node };
	}
	throw new Refusal('no real Node on PATH (Wrangler needs Node >= 22; `node` under `bun run --bun` is Bun)');
}

/** GRS-106's allowlist: everything Wrangler may see. */
function wranglerEnv(node: string, runDir: string): Record<string, string> {
	return {
		PATH: `${path.dirname(node)}:/usr/bin:/bin`,
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

function readSidecar(): Sidecar {
	const file = path.join(root, SIDECAR);
	if (!existsSync(file)) throw new Refusal(`no hosted build: run bun run --bun build:hosted first (${SIDECAR} is missing)`);
	return JSON.parse(readFileSync(file, 'utf8')) as Sidecar;
}

/** The artifact may be served only when it is this commit's, built from a clean tree, and unchanged since. */
function servable(): { sidecar: Sidecar; sha: string } {
	const sha = head(), sidecar = readSidecar();
	if (dirty()) throw new Refusal('the tree is dirty: commit first, so the served artifact is exactly HEAD');
	if (sidecar.stamp.revision !== sha) throw new Refusal(`the artifact is stamped ${sidecar.stamp.revision}, not HEAD ${sha}: rebuild with bun run --bun build:hosted`);
	if (sidecar.stamp.dirty) throw new Refusal('the artifact was built from a dirty tree: commit and rebuild');
	const version = JSON.parse(readFileSync(path.join(root, '.svelte-kit/cloudflare/_app/version.json'), 'utf8')) as { version?: unknown };
	if (version.version !== sha) throw new Refusal(`the artifact's _app/version.json names ${String(version.version)}, not HEAD ${sha}`);
	if (artifactDigest() !== sidecar.artifact) throw new Refusal('the artifact changed after build:hosted wrote it: rebuild');
	return { sidecar, sha };
}

function build() {
	const profile = (process.env.CLEARCASE_HOSTED_PROFILE ?? 'production') as HostedProfile;
	if (profile !== 'production' && profile !== 'hosted-gate') throw new Refusal(`CLEARCASE_HOSTED_PROFILE must be production or hosted-gate, not ${profile}`);
	if (process.versions.bun !== BUN) throw new Refusal(`Bun ${BUN} required, not ${process.versions.bun}`);
	const sha = head(), isDirty = dirty();
	const stamp = { revision: sha, dirty: isDirty, exported: false, builtAt: new Date().toISOString(), bun: process.versions.bun, buildId: `${sha.slice(0, 12)}-${profile}-${Date.now()}`, target: 'cloudflare', profile };
	for (const dir of ['.svelte-kit/cloudflare', '.svelte-kit/output', SIDECAR]) rmSync(path.join(root, dir), { recursive: true, force: true });
	// Credential-free by construction: the build sees this allowlist and nothing of the caller's environment.
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root, TMPDIR: process.env.TMPDIR ?? '/tmp', CLEARCASE_TARGET: 'hosted', CLEARCASE_HOSTED_PROFILE: profile, CLEARCASE_SOURCE_REVISION: sha, CLEARCASE_BUILD_STAMP: JSON.stringify(stamp) };
	const r = run(process.execPath, ['run', '--bun', 'vite', 'build'], env);
	if (r.code !== 0) {
		console.error(r.out.split('\n').slice(-40).join('\n'));
		throw new Error(`vite build for the hosted ${profile} artifact failed (exit ${r.code})`);
	}
	if (!existsSync(path.join(root, '.svelte-kit/cloudflare/_worker.js'))) throw new Error('the build wrote no .svelte-kit/cloudflare/_worker.js');
	const scan = scanArtifact({ root, profile });
	if (scan.errors.length) throw new Error(scan.errors.join('\n'));
	const sidecar: Sidecar = { schema: 'clearcase.hosted-build/1', stamp, artifact: artifactDigest() };
	writeFileSync(path.join(root, SIDECAR), JSON.stringify(sidecar, null, 2) + '\n');
	console.log(`build:hosted: PASS ${profile} artifact ${sidecar.artifact} stamped ${sha}${isDirty ? ' (DIRTY: start:hosted will refuse it)' : ''}; artifact scan PASS (${scan.files} emitted modules)`);
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
function descendants(rootPid: number): Proc[] {
	const all = processes(), ids = new Set([rootPid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of all.values()) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
	}
	return [...ids].map((id) => all.get(id)).filter((p): p is Proc => p !== undefined);
}

/** SIGINT to Wrangler's own process group, then SIGTERM and SIGKILL, until no process of its tree is left. */
async function stopTree(child: ChildProcess, tree: Proc[]) {
	const pgid = child.pid!;
	const left = () => [...processes().values()].filter((p) => p.pgrp === pgid || tree.some((t) => t.pid === p.pid && t.exe === p.exe));
	const gone = () => (child.exitCode !== null || child.signalCode !== null) && left().length === 0;
	for (const [signal, ms] of [['SIGINT', 12_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (gone()) break;
		try {
			process.kill(-pgid, signal);
		} catch {}
		for (const until = Date.now() + ms; Date.now() < until && !gone(); ) await new Promise((r) => setTimeout(r, 100));
	}
	const survivors = left();
	if (survivors.length) throw new Error(`processes survived the stop: ${survivors.map((p) => `${p.pid} ${p.exe}`).join(', ')}`);
}

async function start() {
	const { sidecar, sha } = servable();
	if (existsSync(stateFile)) throw new Refusal(`${path.relative(root, stateFile)} exists: a server may already run on ${port}; run start:hosted --stop first`);
	const node = realNode(), profile = sidecar.stamp.profile;
	const runDir = path.join(root, '.local', 'hosted', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`), persist = path.join(runDir, 'persist'), logs = path.join(runDir, 'logs');
	for (const d of ['home/.config', 'cache', 'logs/wrangler', 'persist']) mkdirSync(path.join(runDir, d), { recursive: true });
	const env = wranglerEnv(node.path, runDir), runId = path.basename(runDir);
	const wrangler = (label: string, ...args: string[]) => {
		const r = run(node.path, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', CONFIG], env);
		writeFileSync(path.join(logs, `wrangler-${label}.log`), r.out);
		if (r.code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (exit ${r.code}); see ${path.relative(root, logs)}/wrangler-${label}.log`);
	};
	// Local D1 and R2 provisioning: the runtime sentinels always, the synthetic two-client fixture for the gate profile.
	const marker = sentinel(runId), fixture = profile === 'hosted-gate' ? gateFixture() : null;
	const sqlFile = path.join(runDir, 'provision.sql'), objects = [{ key: marker.key, bytes: marker.bytes }, ...(fixture?.objects ?? [])];
	writeFileSync(sqlFile, [marker.sql, fixture?.sql ?? ''].join('\n'));
	wrangler('d1', 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--file', sqlFile);
	objects.forEach((o, i) => {
		const file = path.join(runDir, `object-${i}`);
		writeFileSync(file, o.bytes);
		wrangler(`r2-${i}`, 'r2', 'object', 'put', `clearcase-local-only/${o.key}`, '--local', '--persist-to', persist, '--file', file);
	});
	const vars = fixture ? ['--var', `CLEARCASE_GATE_RUN:${runId}`, '--var', `CLEARCASE_GATE_FIXTURE:${fixture.sha256}`] : [];
	const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', CONFIG, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false', ...vars];
	const child = spawn(node.path, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	const log = createWriteStream(path.join(logs, 'wrangler-dev.log'));
	let text = '';
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no "Ready on" from Wrangler within 60 s')), 60_000);
		const onData = (b: Buffer) => {
			log.write(b);
			text += b.toString();
			if (text.includes('Ready on')) (clearTimeout(timer), resolve());
		};
		child.stdout!.on('data', onData);
		child.stderr!.on('data', onData);
		child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`Wrangler exited ${code} before Ready: ${text.slice(-1500)}`))));
	}).catch(async (e) => {
		await stopTree(child, descendants(child.pid!)).catch(() => undefined);
		throw e;
	});
	const tree = descendants(child.pid!);
	let stopping = false;
	const stop = async (reason: string, code: number) => {
		if (stopping) return;
		stopping = true;
		console.error(`start:hosted: stopping (${reason})`);
		try {
			await stopTree(child, descendants(child.pid!).concat(tree));
		} catch (e) {
			console.error(`start:hosted: ${e instanceof Error ? e.message : String(e)}`);
			code = 1;
		}
		rmSync(stateFile, { force: true });
		removePidFile(pidFile);
		process.exit(code);
	};
	process.on('SIGTERM', () => void stop('SIGTERM', 0));
	process.on('SIGINT', () => void stop('SIGINT', 0));
	child.once('exit', (code) => void stop(`Wrangler exited ${code}`, 1));
	try {
		if (!tree.some((p) => p.exe === 'workerd')) throw new Error('no native workerd process under Wrangler');
		const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15_000) });
		const body = (await health.json()) as { ok?: boolean; runtime?: string; build?: { revision?: string; profile?: string } | null };
		if (health.status !== 200 || body.ok !== true || body.build?.revision !== sha || body.build.profile !== profile || body.runtime !== 'Cloudflare-Workers') throw new Error(`/health did not report this artifact on workerd: ${health.status} ${JSON.stringify(body)}`);
	} catch (e) {
		console.error(`start:hosted: ${e instanceof Error ? e.message : String(e)}`);
		return stop('failed start-up check', 1);
	}
	const state: ServerState = { schema: 'clearcase.hosted-server/1', pid: process.pid, port, base, revision: sha, profile, artifact: sidecar.artifact, runDir: path.relative(root, runDir), persist: path.relative(root, persist), runId, fixtureSha256: fixture?.sha256 ?? null, node: node.version, startedAt: new Date().toISOString() };
	writePidFile(pidFile);
	writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
	console.log(`start:hosted: serving ${base} on workerd (${profile}, ${sha}); Wrangler on Node ${node.version}; state ${path.relative(root, runDir)}. Stop with bun run --bun start:hosted --stop (PORT=${port}).`);
}

async function test() {
	if (!existsSync(stateFile)) throw new Refusal(`no hosted server on ${port}: run bun run --bun start:hosted first`);
	const state = JSON.parse(readFileSync(stateFile, 'utf8')) as ServerState;
	const { sidecar, sha } = servable();
	if (state.revision !== sha || state.artifact !== sidecar.artifact) throw new Refusal(`the running server (${state.revision}, ${state.artifact}) is not HEAD's artifact (${sha}, ${sidecar.artifact})`);
	const node = realNode();
	const env = wranglerEnv(node.path, path.join(root, state.runDir));
	// Audit rows are read back from local D1 by Wrangler's own CLI, outside the Worker.
	const query = (sql: string) => {
		const r = run(node.path, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--persist-to', path.join(root, state.persist), '--config', CONFIG, '--json', '--command', sql], env);
		if (r.code !== 0) throw new Error(`wrangler d1 execute failed: ${r.out.slice(-400)}`);
		return (JSON.parse(r.out.slice(r.out.indexOf('['))) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
	};
	const legs = await smoke({ base, profile: state.profile, revision: sha, query, root });
	// The import-boundary negative test: each committed mutant in its own disposable checkout must be refused.
	const negative = run(process.execPath, ['tests/hosted-foundation/runtime/guard-mutations.ts'], { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root, TMPDIR: process.env.TMPDIR ?? '/tmp' });
	const mutants = negative.out.split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
	legs.push({ name: 'import-boundary-negative', status: negative.code === 0 && mutants.length > 0 && mutants.every((l) => l.startsWith('PASS')) ? 'PASS' : 'FAIL', asserted: mutants, failure: negative.code === 0 ? undefined : negative.out.split('\n').slice(-12).join('\n') });
	const pass = legs.every((l) => l.status === 'PASS') && head() === sha && !dirty();
	const summary = { schema: 'clearcase.hosted-test/1', revision: sha, profile: state.profile, artifact: state.artifact, base, runtime: 'workerd via wrangler dev --local', node: node.version, bun: process.versions.bun, pass, legs, at: new Date().toISOString() };
	const out = path.join(root, '.local', 'hosted', `test-${sha.slice(0, 12)}-${state.profile}.json`);
	writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
	for (const l of legs) console.log(`${l.status} ${l.name} (${l.asserted.length} assertions)${l.failure ? `: ${l.failure}` : ''}`);
	console.log(`test:hosted: ${pass ? 'PASS' : 'FAIL'} ${state.profile} at ${sha}; summary ${path.relative(root, out)}`);
	process.exitCode = pass ? 0 : 1;
}

const command = process.argv[2];
try {
	if (command === 'build') build();
	else if (command === 'start' && process.argv.includes('--stop')) {
		const { ok, message } = await stopPidFile(pidFile, { graceMs: 30_000 });
		console.log(`start:hosted --stop: ${message}`);
		process.exitCode = ok ? 0 : 1;
	} else if (command === 'start') await start();
	else if (command === 'test') await test();
	else throw new Refusal('usage: bun scripts/pilot/hosted.ts build|start [--stop]|test');
} catch (e) {
	console.error(`hosted ${command}: ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = e instanceof Refusal ? 2 : 1;
}
