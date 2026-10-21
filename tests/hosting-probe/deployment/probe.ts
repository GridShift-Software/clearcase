// The offline legs of the deployment proof (GRS-107): GRS-102's P1 to P9 against fresh pins, local D1 migration
// failure and rollback, Void's config evaluation and automatic migrations, the trusted parent's wrong-client check, the
// janitor's dry run, and a credential scan of every artifact, log and output. From this directory:
//
//   bun install --frozen-lockfile   # once, online: this workspace's own pins, apart from the root lockfile
//   bun run --bun probe [--out FILE]
//
// It re-runs itself inside tests/e2e/pilot/offline.sh (a network namespace with only loopback, the host resolver
// hidden), so no account, login or request can reach Cloudflare; every account ID is a placeholder. Node hosts cf,
// Wrangler, Void and Vitest (each Node step loads net-recorder.mjs, which logs every connect and DNS lookup); Bun hosts
// this runner, the app build and the probes' own tools. Every child gets an explicit environment allowlist; the runner
// itself holds canary credentials, as the trusted parent would hold real ones, and the scan proves none reached a child's
// output. Scratch copies under .local/hosting-probe/deployment/<run>/ take every build, so the tree stays clean. It
// refuses (exit 2) a dirty tree, a Bun other than packageManager's, an installed package that is not its pin, or a Node
// that is really Bun; otherwise it writes the summary (default .local/hosting-probe/deployment/summary.json) and exits 0
// only when every leg passed, the scan found nothing, and HEAD and the tree did not change.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanPaths } from '../../../deploy/probes/scan.ts';
import { checkTarget, digestDir, loadTargets } from '../../../deploy/probes/target.ts';

const HERE = import.meta.dirname;
const SCHEMA = 'clearcase.deployment-probe/1';
const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
const BUN = pkg.packageManager.replace(/^bun@/, '');
const LOCAL_D1 = '00000000-0000-4000-8000-000000000107';
const PLACEHOLDER_ACCOUNT = '00000000000000000000000000000107';
const PORT = 18797;
const HOLD = [
	'P10 (moment M1, Workers Free): a real prebuilt upload with an upload-only token, enforced token grants and denied actions, a Void deploy with pending D1 migrations behind a time-travel bookmark, a Worker rollback, and teardown of cc-* resources through the run manifest',
	"the janitor's real sweep of the account's cc-* resources (M1)",
	'actual token breadth on the real API: no resource-scoped Worker or D1 token is claimed',
];

class Refusal extends Error {}

type Step = { cmd: string; host: string; exit: number | null; ms: number; network: string[] | 'not recorded (Bun host)' };
type Leg = { title: string; status: 'PASS' | 'FAIL' | 'NOT RUN'; steps: Step[]; observed: Record<string, unknown>; asserted: string[]; failure?: string };

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
	const started = Date.now();
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HERE, env: opts.env ?? {}, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 240_000 });
	return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`, ms: Date.now() - started };
}

function git(...args: string[]): string {
	const r = run('git', args, { env: { PATH: '/usr/bin:/bin' } });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
}
const repo = () => git('rev-parse', '--show-toplevel');
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all');

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
	throw new Refusal('no real Node on PATH (cf, Wrangler and Void need Node; `node` under `bun run --bun` is Bun)');
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
	const ip = (...a: string[]) => JSON.parse(run('ip', ['-j', ...a], { env: { PATH: '/usr/bin:/bin' } }).out) as unknown[];
	const links = (ip('addr') as { ifname: string }[]).map((l) => l.ifname);
	const r4 = ip('-4', 'route'), r6 = ip('-6', 'route');
	if (links.join() !== 'lo' || r4.length || r6.length) throw new Refusal(`not offline: interfaces ${links.join(',')}, ${r4.length} IPv4 and ${r6.length} IPv6 routes`);
	return 'own network namespace: interfaces [lo], 0 IPv4 routes, 0 IPv6 routes; host resolver sockets hidden';
}

/** `version` satisfies a range of `^a.b.c || ^d.e.f` alternatives, the only form the pinned engines fields use. */
function satisfies(version: string, range: string): boolean {
	const v = version.split('.').map(Number);
	return range.split('||').some((alt) => {
		const m = /^\s*(\^|>=)(\d+)\.(\d+)\.(\d+)\s*$/.exec(alt);
		if (!m) return false;
		const want = [Number(m[2]), Number(m[3]), Number(m[4])];
		const cmp = v[0]! - want[0]! || v[1]! - want[1]! || v[2]! - want[2]!;
		return m[1] === '>=' ? cmp >= 0 : v[0] === want[0] && cmp >= 0;
	});
}

/** Relative path to sha256 of every file under `dir` but node_modules, to tell which files a step wrote. */
function snapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const rel = path.relative(dir, path.join(e.parentPath, e.name));
		if (!e.isFile() || rel.split(path.sep)[0] === 'node_modules') continue;
		out.set(rel, createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex'));
	}
	return out;
}
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
	const tops = new Set<string>();
	for (const [f, h] of after) if (before.get(f) !== h) tops.add(f.split(path.sep).slice(0, 2).join('/'));
	for (const f of before.keys()) if (!after.has(f)) tops.add(`deleted ${f}`);
	return [...tops].sort();
}

const LOOPBACK = /^(?:127\.|::1|\[::1\]|localhost(?::|$)|0\.0\.0\.0|\/)/;

type Server = { child: ChildProcess; label: string };

async function main(out: string): Promise<number> {
	const root = repo();
	const sha = head();
	if (dirty()) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
	rmSync(out, { force: true });
	const runDir = path.join(root, '.local', 'hosting-probe', 'deployment', new Date().toISOString().replace(/[:.]/g, '-'));
	const logs = path.join(runDir, 'logs');
	const home = path.join(runDir, 'home');
	for (const d of [logs, path.join(home, '.config'), path.join(home, '.cache'), path.join(logs, 'net'), path.join(logs, 'wrangler')]) mkdirSync(d, { recursive: true });
	const startedAt = new Date().toISOString();

	// The trusted parent's credentials, as canaries: in this process only. No child below gets them, except the Void
	// config-evaluation leg, which hands one to Void on purpose under its own HOME to show what config code can read.
	const canaries = { token: `cfat_canary${randomBytes(18).toString('hex')}`, clerk: `sk_test_canary${randomBytes(18).toString('hex')}` };
	process.env.CLOUDFLARE_API_TOKEN = canaries.token;
	process.env.CLERK_SECRET_KEY = canaries.clerk;

	const bunPath = process.execPath;
	const baseEnv: Record<string, string> = {
		PATH: `${path.dirname(node.path)}:${path.dirname(bunPath)}:/usr/bin:/bin`,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, '.config'),
		XDG_CACHE_HOME: path.join(home, '.cache'),
		CI: '1',
		DO_NOT_TRACK: '1',
		CLOUDFLARE_DEPENDENCIES_INSTRUMENTATION: 'false',
		WRANGLER_SEND_METRICS: 'false',
		WRANGLER_SEND_ERROR_REPORTS: 'false',
		WRANGLER_HIDE_BANNER: 'true',
		WRANGLER_LOG_PATH: path.join(logs, 'wrangler'),
		CLOUDFLARE_CF_FETCH_ENABLED: 'false',
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
		CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
	};
	const tool = { cf: path.join(HERE, 'node_modules/cf/bin/cf'), wrangler: path.join(HERE, 'node_modules/wrangler/bin/wrangler.js'), void: path.join(HERE, 'node_modules/void/dist/cli/cli.mjs'), vitest: path.join(HERE, 'node_modules/vitest/vitest.mjs'), vite: path.join(HERE, 'node_modules/vite/bin/vite.js') };
	const show = (s: string) => s.replaceAll(runDir, '<run>').replaceAll(HERE, '<probe>').replaceAll(root, '<repo>').replaceAll(node.path, 'node').replaceAll(bunPath, 'bun');

	const legs: Record<string, Leg> = {};
	let stepNo = 0;
	/** Runs one command for a leg, logs its output, and records its exit, time and (for Node) every non-loopback connect or lookup. */
	const step = (leg: Leg, host: 'Node' | 'Bun', cmd: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }) => {
		const n = ++stepNo;
		const net = path.join(logs, 'net', `${n}.jsonl`);
		const env = { ...baseEnv, ...(host === 'Node' ? { NODE_OPTIONS: `--import=${path.join(HERE, 'net-recorder.mjs')}`, PROBE_NET_LOG: net } : {}), ...opts.env };
		const [exe, ...args] = host === 'Node' ? [node.path, ...cmd] : [bunPath, ...cmd];
		const r = run(exe!, args, { cwd: opts.cwd, env, timeoutMs: opts.timeoutMs });
		writeFileSync(path.join(logs, `${n}.log`), `$ ${show([host === 'Node' ? 'node' : 'bun', ...cmd].join(' '))}\n${r.out}\nexit ${r.code}\n`);
		const network =
			host === 'Node'
				? [...new Set((existsSync(net) ? readFileSync(net, 'utf8').split('\n').filter(Boolean) : []).map((l) => (JSON.parse(l) as { target: string }).target).filter((t) => !LOOPBACK.test(t)))]
				: ('not recorded (Bun host)' as const);
		leg.steps.push({ cmd: show(`${host === 'Node' ? 'node' : 'bun'} ${cmd.join(' ')}`), host, exit: r.code, ms: r.ms, network });
		return { code: r.code, out: r.out, network };
	};
	const live = new Set<Server>();
	const serve = async (leg: Leg, cwd: string, persist: string, label: string): Promise<Server> => {
		const args = [tool.wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false'];
		const child = spawn(node.path, args, { cwd, env: baseEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const server = { child, label };
		live.add(server);
		let text = '';
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label}: no "Ready on" within 60 s`)), 60_000);
			const onData = (b: Buffer) => {
				text += b.toString();
				if (text.includes('Ready on')) (clearTimeout(timer), resolve());
			};
			child.stdout!.on('data', onData);
			child.stderr!.on('data', onData);
			child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${label}: Wrangler exited ${code} before Ready`))));
		}).finally(() => appendFileSync(path.join(logs, `wrangler-dev-${label}.log`), text));
		leg.steps.push({ cmd: show(`node ${args.join(' ')}`), host: 'Node', exit: null, ms: 0, network: 'not recorded (Bun host)' });
		return server;
	};
	const stop = async (server: Server) => {
		for (const [signal, ms] of [['SIGINT', 10_000], ['SIGKILL', 5_000]] as const) {
			if (server.child.exitCode !== null || server.child.signalCode !== null) break;
			try {
				process.kill(-server.child.pid!, signal);
			} catch {}
			for (const until = Date.now() + ms; Date.now() < until && server.child.exitCode === null && server.child.signalCode === null; ) await new Promise((r) => setTimeout(r, 100));
		}
		live.delete(server);
	};

	async function leg(id: string, title: string, body: (l: Leg, check: (ok: boolean, what: string) => void) => Promise<void> | void) {
		const l: Leg = { title, status: 'NOT RUN', steps: [], observed: {}, asserted: [] };
		legs[id] = l;
		const check = (ok: boolean, what: string) => {
			if (!ok) throw new Error(what);
			l.asserted.push(what);
		};
		try {
			await body(l, check);
			l.status = 'PASS';
		} catch (e) {
			l.status = 'FAIL';
			l.failure = show(e instanceof Error ? e.message : String(e));
		} finally {
			for (const s of [...live]) await stop(s);
		}
		console.log(`${l.status.padEnd(5)} ${id}${l.failure ? `: ${l.failure.slice(0, 300)}` : ''}`);
	}

	/** A scratch copy of the probe app sharing this workspace's node_modules. */
	const copyApp = (name: string, edit?: (dir: string) => void) => {
		const dir = path.join(runDir, name);
		cpSync(path.join(HERE, 'app'), dir, { recursive: true });
		symlinkSync(path.join(HERE, 'node_modules'), path.join(dir, 'node_modules'));
		edit?.(dir);
		return dir;
	};
	const kitAsViteConfig = (dir: string) => renameSync(path.join(dir, 'vite.probe.config.js'), path.join(dir, 'vite.config.js'));
	const targets = loadTargets();
	const clientA = targets.find((t) => t.client === 'client-a')!;
	const clientB = targets.find((t) => t.client === 'client-b')!;
	const bindingNames = (out: string) => [...out.matchAll(/env\.(\w+) \(([^)]+)\)/g)].map((m) => `${m[1]}=${m[2]}`).sort();
	const jsonIn = (out: string): unknown => {
		try {
			return JSON.parse(out.slice(out.search(/[[{]/), Math.max(out.lastIndexOf('}'), out.lastIndexOf(']')) + 1));
		} catch {
			return null;
		}
	};
	const lastJson = (out: string, prefix = '') => {
		const line = out.split('\n').reverse().find((l) => l.startsWith(prefix) && l.slice(prefix.length).trim().startsWith('{'));
		return line ? (JSON.parse(line.slice(prefix.length)) as Record<string, unknown>) : null;
	};

	const cfConfig = (name: string, extra = '') => `export default {\n  "accountId": "${PLACEHOLDER_ACCOUNT}",\n  "worker": { "name": "${name}", "compatibilityDate": "2026-10-12", "compatibilityFlags": ["nodejs_als"]${extra} }\n};\n`;
	const plain = path.join(runDir, 'plain');
	mkdirSync(path.join(plain, 'src'), { recursive: true });
	writeFileSync(path.join(plain, 'package.json'), `${JSON.stringify({ name: 'plain-probe', private: true, type: 'module', devDependencies: { wrangler: pins.wrangler } })}\n`);
	writeFileSync(path.join(plain, 'src/index.js'), 'export default { fetch() { return new Response("synthetic"); } };\n');
	writeFileSync(path.join(plain, 'cloudflare.config.ts'), cfConfig('clearcase-plain-probe', `, "entrypoint": "./src/index.js", "env": { "DB": { "type": "d1", "name": "plain-probe-db", "id": "${LOCAL_D1}" } }`));
	symlinkSync(path.join(HERE, 'node_modules'), path.join(plain, 'node_modules'));

	await leg('P1-discovery', 'cf discovery and schema commands under Node, and cf under Bun in a project with cloudflare.config.ts', (l, check) => {
		const v = step(l, 'Node', [tool.cf, '--version'], { cwd: plain });
		check(v.code === 0 && v.out.trim() === pins.cf, `cf --version prints ${pins.cf}`);
		const search = step(l, 'Node', [tool.cf, 'cli', 'search', 'create D1 database'], { cwd: plain });
		const matches = JSON.parse(search.out) as { command: string }[];
		check(search.code === 0 && matches.some((m) => m.command === 'cf d1 create'), 'cf cli search answers offline with JSON on stdout naming cf d1 create');
		const schema = step(l, 'Node', [tool.cf, 'schema', 'd1', 'create'], { cwd: plain });
		check(schema.code === 0 && (JSON.parse(schema.out) as { operationId: string }).operationId === 'd1.create', 'cf schema d1 create answers offline with the d1.create operation as JSON');
		const bunVersion = step(l, 'Bun', [tool.cf, '--version'], { cwd: plain });
		const bunDry = step(l, 'Bun', [tool.cf, 'deploy', '--dry-run', '--no-provision'], { cwd: plain });
		const nodeDry = step(l, 'Node', [tool.cf, 'deploy', '--dry-run', '--no-provision'], { cwd: plain });
		check(nodeDry.code === 0 && nodeDry.out.includes('--dry-run: exiting now'), 'under Node, cf deploy --dry-run --no-provision completes in a plain Worker project with cloudflare.config.ts');
		l.observed = {
			cfEngines: '^22.23.0 || ^24.22.0 || ^26.12.0',
			nodeSatisfiesCfEngines: satisfies(node.version, '^22.23.0 || ^24.22.0 || ^26.12.0'),
			bun: { version: { exit: bunVersion.code, out: bunVersion.out.trim().slice(0, 80) }, deployDryRun: { exit: bunDry.code, completed: bunDry.out.includes('--dry-run: exiting now'), mentionsBun: /\bbun\b/i.test(bunDry.out) } },
			searchMatches: matches.map((m) => m.command),
		};
	});

	await leg('P2a-kit-no-config', 'Kit 3.1.0 + adapter 8.0.1 without cloudflare.config.ts: cf automatic setup', (l, check) => {
		const kit = copyApp('kit-no-config', kitAsViteConfig);
		const before = snapshot(kit);
		const init = step(l, 'Node', [tool.cf, 'init', '.', '--dry-run'], { cwd: kit });
		const build = step(l, 'Node', [tool.cf, 'build'], { cwd: kit });
		const deploy = step(l, 'Node', [tool.cf, 'deploy', '--dry-run'], { cwd: kit });
		const refusal = 'cf does not support SvelteKit projects yet';
		check(build.code === 1 && build.out.includes(refusal), `cf build refuses: "${refusal}"`);
		check(deploy.code === 1 && deploy.out.includes(refusal), 'cf deploy --dry-run refuses the same way');
		const writes = changed(before, snapshot(kit));
		check(writes.length === 0, 'the refused commands wrote no file into the project');
		l.observed = { initDryRun: { exit: init.code, out: jsonIn(init.out) }, refusal, fallback: 'Bun-hosted vite build with adapter 8, served and deployed through Wrangler or a cf prebuilt entrypoint (P3, P9)' };
	});

	await leg('P2b-kit-cf-config', 'Kit 3.1.0 + adapter 8.0.1 with a hand-written cloudflare.config.ts: cf build and cf deploy --dry-run', (l, check) => {
		const kit = copyApp('kit-cf-config', (d) => (kitAsViteConfig(d), writeFileSync(path.join(d, 'cloudflare.config.ts'), cfConfig('clearcase-deployment-probe', `, "env": { "DB": { "type": "d1", "name": "probe-local-only", "id": "${LOCAL_D1}" } }`))));
		const build = step(l, 'Node', [tool.cf, 'build'], { cwd: kit });
		const buildOutput = existsSync(path.join(kit, '.cloudflare/output/v0/config.json'));
		const worker = existsSync(path.join(kit, '.svelte-kit/cloudflare/_worker.js'));
		const deploy = step(l, 'Node', [tool.cf, 'deploy', '--dry-run', '--no-provision'], { cwd: kit });
		const error = /Build Output Specification[^\n]*\n?[^\n]*/.exec(build.out)?.[0]?.replace(/│/g, '').replace(/\s+/g, ' ').trim() ?? null;
		check(build.code !== null, 'cf build ran to an exit code');
		check(worker, 'the framework build ran: adapter 8 wrote .svelte-kit/cloudflare/_worker.js');
		l.observed = { buildExit: build.code, buildOutputWritten: buildOutput, error: error && show(error), deployDryRunExit: deploy.code, deployDryRunCompleted: deploy.out.includes('--dry-run: exiting now') };
	});

	// P3 builds the artifact every later leg stages.
	const kit = copyApp('kit');
	const artifact = path.join(runDir, 'artifact');
	await leg('P3-build-workerd', 'Bun build of the Kit 3 app, served by wrangler dev on workerd, and one createTestHarness request', async (l, check) => {
		// Built in place, as GRS-106's probe is: Kit's route analysis under Bun cannot load a Vite config through the
		// scratch copy's symlinked node_modules. .svelte-kit is ignored; it moves to the scratch copy right after.
		const app = path.join(HERE, 'app');
		rmSync(path.join(app, '.svelte-kit'), { recursive: true, force: true });
		const build = step(l, 'Bun', ['run', '--bun', 'build'], { cwd: app });
		cpSync(path.join(app, '.svelte-kit'), path.join(kit, '.svelte-kit'), { recursive: true });
		rmSync(path.join(app, '.svelte-kit'), { recursive: true, force: true });
		check(build.code === 0 && build.out.includes(`[probe build host] {"bun":"${BUN}"`), `bun run --bun build exits 0 with Bun ${BUN} hosting vite`);
		for (const f of ['.svelte-kit/cloudflare/_worker.js', '.svelte-kit/cloudflare/.assetsignore', '.svelte-kit/cloudflare-tmp/server.js']) check(existsSync(path.join(kit, f)), `the build wrote ${f}`);
		mkdirSync(path.join(artifact, 'output'), { recursive: true });
		for (const d of ['cloudflare', 'cloudflare-tmp']) cpSync(path.join(kit, '.svelte-kit', d), path.join(artifact, d), { recursive: true });
		cpSync(path.join(kit, '.svelte-kit/output/server'), path.join(artifact, 'output/server'), { recursive: true });
		const persist = path.join(runDir, 'persist/p3');
		const migrate = step(l, 'Node', [tool.wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: kit });
		check(migrate.code === 0, 'wrangler d1 migrations apply --local creates the schema');
		const server = await serve(l, kit, persist, 'p3');
		const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(15_000) });
		const health = (await res.json()) as Record<string, unknown>;
		check(res.status === 200 && health.client === 'probe-local' && health.notes === 1 && health.bucket === true, 'GET /api/health answers 200 from workerd with the local client, one seeded note and the R2 binding');
		await stop(server);
		const harness = step(l, 'Node', ['harness.mjs'], { cwd: kit });
		const h = lastJson(harness.out, '[harness] ');
		check(harness.code === 0 && h?.status === 200 && (h.body as Record<string, unknown>).client === 'probe-local', 'createTestHarness serves /api/health from the built Worker under Node');
		const bunHarness = step(l, 'Bun', ['harness.mjs'], { cwd: kit });
		l.observed = { artifact: digestDir(artifact), health, harnessUnderBun: { exit: bunHarness.code, userError: /UserError|cannot reach the Worker|Bun/.test(bunHarness.out) } };
	});

	await leg('P4-local-migrations', 'the same synthetic migrations through cf and Wrangler --local --persist-to, and which state a dev server reads', async (l, check) => {
		const x = path.join(runDir, 'persist/p4-cf'), y = path.join(runDir, 'persist/p4-wrangler');
		const cf = step(l, 'Node', [tool.cf, 'd1', 'migrations', 'apply', LOCAL_D1, '--local', '--persist-to', x, '--dir', 'migrations'], { cwd: kit });
		check(cf.code === 0, 'cf d1 migrations apply --local --persist-to X exits 0');
		const wr = step(l, 'Node', [tool.wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', y], { cwd: kit });
		check(wr.code === 0, 'wrangler d1 migrations apply --local --persist-to Y exits 0');
		const rows = (persist: string) => {
			const r = step(l, 'Node', [tool.wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', '--command', 'SELECT id, name FROM d1_migrations ORDER BY id'], { cwd: kit });
			try {
				return (JSON.parse(r.out) as { results: unknown[] }[])[0]!.results;
			} catch {
				return { exit: r.code, unreadable: true };
			}
		};
		const cfQuery = step(l, 'Node', [tool.cf, 'd1', 'query', LOCAL_D1, '--local', '--persist-to', x, '--sql', 'SELECT id, name FROM d1_migrations ORDER BY id'], { cwd: kit });
		const cfRaw = step(l, 'Node', [tool.cf, 'd1', 'raw', LOCAL_D1, '--local', '--persist-to', x, '--sql', 'SELECT id, name FROM d1_migrations ORDER BY id'], { cwd: kit });
		const viaCf = (() => {
			const raw = jsonIn(cfRaw.out) as { results?: { rows?: [number, string][] } }[] | null;
			const rowsOf = raw?.[0]?.results?.rows;
			return Array.isArray(rowsOf) ? rowsOf.map(([id, name]) => ({ id, name })) : { exit: cfRaw.code, unreadable: true };
		})();
		const wranglerReadsX = rows(x), wranglerReadsY = rows(y);
		check(JSON.stringify(wranglerReadsY) === JSON.stringify([{ id: 1, name: '0001_notes.sql' }, { id: 2, name: '0002_tags.sql' }]), "Wrangler's d1_migrations rows are 0001_notes.sql and 0002_tags.sql");
		check(JSON.stringify(viaCf) === JSON.stringify(wranglerReadsY), "cf's d1_migrations rows (read with cf d1 raw --local; cf d1 query has no local form) equal Wrangler's");
		check(JSON.stringify(wranglerReadsX) === JSON.stringify(wranglerReadsY), "Wrangler reads the state cf wrote under --persist-to X: one local layout");
		const server = await serve(l, kit, x, 'p4-cf-state');
		const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(15_000) });
		const devReadsX = { status: res.status, body: await res.text() };
		await stop(server);
		l.observed = { cfQueryLocal: { exit: cfQuery.code, unsupported: /no local equivalent/.test(cfQuery.out) }, cfRows: viaCf, wranglerRows: wranglerReadsY, wranglerReadsCfState: wranglerReadsX, wranglerDevOnCfState: { status: devReadsX.status, schemaVisible: devReadsX.status === 200 } };
	});

	await leg('migration-failure-rollback', 'a failing migration on local D1, the bookmark taken first, and the rollback to it', async (l, check) => {
		const persist = path.join(runDir, 'persist/failure');
		const dir = copyApp('kit-failing');
		const ok = step(l, 'Node', [tool.wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: dir });
		check(ok.code === 0, 'migrations 0001 and 0002 apply');
		const query = (sql: string) => {
			const r = step(l, 'Node', [tool.wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', '--command', sql], { cwd: dir });
			return (JSON.parse(r.out) as { results: Record<string, unknown>[] }[])[0]!.results;
		};
		const state = () => ({ migrations: query('SELECT name FROM d1_migrations ORDER BY id').map((r) => r.name), notes: query('SELECT id FROM notes ORDER BY id').map((r) => r.id) });
		const before = state();
		// the local stand-in for a D1 time-travel bookmark: the persisted state, copied before the migration runs
		const bookmark = path.join(runDir, 'persist/failure-bookmark');
		cpSync(persist, bookmark, { recursive: true });
		const bookmarkDigest = digestDir(bookmark);
		cpSync(path.join(dir, 'migrations-failing/0003_broken.sql'), path.join(dir, 'migrations/0003_broken.sql'));
		const failed = step(l, 'Node', [tool.wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: dir });
		check(failed.code !== 0, 'the broken migration 0003 exits nonzero');
		const after = state();
		check(JSON.stringify(after.migrations) === JSON.stringify(before.migrations), '0003 is not recorded in d1_migrations');
		const partial = after.notes.includes('from-0003');
		const retry = step(l, 'Node', [tool.wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: dir });
		check(retry.code !== 0, 'a retry fails the same way: migrations are forward-only and nothing skips a broken one');
		rmSync(persist, { recursive: true });
		cpSync(bookmark, persist, { recursive: true });
		const restored = state();
		check(JSON.stringify(restored) === JSON.stringify(before) && digestDir(bookmark) === bookmarkDigest, 'restoring the bookmark copy returns the schema and rows to their state before 0003');
		l.observed = { before, afterFailure: after, firstStatementOf0003Kept: partial, afterRollback: restored, rollback: 'restore the bookmark (locally a copy of the persisted state; remotely `wrangler d1 time-travel restore` or `void db restore --bookmark`), then fix forward with a new migration' };
	});

	await leg('P5-vitest-pool', '@cloudflare/vitest-plugin with Vitest 5 under Node and under Bun', (l, check) => {
		const viaNode = step(l, 'Node', [tool.vitest, 'run', '--config', 'vitest.workers.config.mjs'], { cwd: kit });
		check(viaNode.code === 0 && /1 passed/.test(viaNode.out), 'under Node the Workers pool runs the bindings test in workerd and it passes');
		const viaBun = step(l, 'Bun', ['--bun', tool.vitest, 'run', '--config', 'vitest.workers.config.mjs'], { cwd: kit });
		l.observed = { node: 'supported: 1 passed', bun: { exit: viaBun.code, passed: /1 passed/.test(viaBun.out), firstError: show(/(?:Error|error)[^\n]{0,200}/.exec(viaBun.out)?.[0] ?? '') } };
	});

	await leg('P6-void-native-d1', 'Void with Kit 3, native env.DB and hand-written SQL, no Drizzle: inference, build, bundle, config evaluation and automatic migrations', (l, check) => {
		const app = copyApp('void-app', (d) => {
			rmSync(path.join(d, 'wrangler.jsonc'));
			rmSync(path.join(d, 'vite.probe.config.js'));
			writeFileSync(path.join(d, 'vite.config.js'), "import adapter from '@sveltejs/adapter-cloudflare';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { voidPlugin } from 'void';\n\nexport default { plugins: [voidPlugin(), sveltekit({ adapter: adapter({ config: './.void-wrangler.jsonc', platformProxy: { configPath: './.void-wrangler.jsonc' } }) })] };\n");
			// Records, by name only, whether the process evaluating this config can read a deploy credential.
			writeFileSync(path.join(d, 'void.config.ts'), "import { appendFileSync } from 'node:fs';\nimport { defineConfig } from 'void/config';\n\nappendFileSync(process.env.PROBE_CONFIG_EVAL_LOG ?? '/dev/null', `${JSON.stringify({ pid: process.pid, entry: (process.argv[1] ?? '').split('/').slice(-3).join('/'), sawDeployToken: typeof process.env.CLOUDFLARE_API_TOKEN === 'string' })}\\n`);\n\nexport default defineConfig({ cloudflare: { name: 'clearcase-void-probe', compatibility_date: '2026-10-12', compatibility_flags: ['nodejs_als'] } });\n");
			mkdirSync(path.join(d, 'db'), { recursive: true });
			cpSync(path.join(d, 'migrations'), path.join(d, 'db/migrations'), { recursive: true });
		});
		const evalLog = path.join(logs, 'void-config-eval.jsonl');
		const voidHome = path.join(runDir, 'void-home');
		mkdirSync(path.join(voidHome, '.config'), { recursive: true });
		const env = { HOME: voidHome, XDG_CONFIG_HOME: path.join(voidHome, '.config'), XDG_CACHE_HOME: path.join(voidHome, '.cache'), PROBE_CONFIG_EVAL_LOG: evalLog };
		const credentialed = { ...env, CLOUDFLARE_API_TOKEN: canaries.token, CLOUDFLARE_ACCOUNT_ID: PLACEHOLDER_ACCOUNT };
		const info = step(l, 'Node', [tool.void, 'info', '--json'], { cwd: app, env });
		const infoJson = (() => {
			try {
				return JSON.parse(info.out.slice(info.out.indexOf('{'))) as unknown;
			} catch {
				return null;
			}
		})();
		check(info.code === 0 && infoJson !== null, 'void info --json answers offline with JSON');
		const build = step(l, 'Node', [tool.vite, 'build'], { cwd: app, env: credentialed });
		const built = build.code === 0 && existsSync(path.join(app, '.svelte-kit/cloudflare/_worker.js'));
		const bundled = (needle: string) => (built ? readdirSync(path.join(app, '.svelte-kit'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(?:js|mjs)$/.test(e.name) && readFileSync(path.join(e.parentPath, e.name), 'utf8').includes(needle)).length : 'no bundle');
		const generated = existsSync(path.join(app, '.void-wrangler.jsonc')) ? readFileSync(path.join(app, '.void-wrangler.jsonc'), 'utf8') : '';
		const deploy = step(l, 'Node', [tool.void, 'deploy', '--platform', 'cloudflare'], { cwd: app, env: credentialed, timeoutMs: 180_000 });
		check(deploy.code !== 0 && /provision/i.test(deploy.out) && /d1 list/i.test(deploy.out), 'offline, void deploy stops in provisioning, before any build or migration, after inferring a D1 database it tries to list');
		const evaluations = existsSync(evalLog) ? readFileSync(evalLog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as { entry: string; sawDeployToken: boolean }) : [];
		check(evaluations.length > 0, 'void.config.ts is code that Void and Vite evaluate');
		check(evaluations.some((e) => e.sawDeployToken), "config code evaluated in the credentialed process reads its deploy token: scrubbing the build child's environment alone does not protect it");
		const dist = path.join(HERE, 'node_modules/void/dist');
		const source = readdirSync(dist).filter((f) => f.startsWith('deploy-') && f.endsWith('.mjs')).map((f) => ({ f, text: readFileSync(path.join(dist, f), 'utf8') }));
		const migrates = source.find((s) => s.text.includes('applyAndVerifyRemoteD1Migrations') && s.text.includes('d1.time-travel.bookmark'));
		check(migrates !== undefined, `void ${pins.void}'s deploy applies remote D1 migrations itself, after a time-travel bookmark (source, not run)`);
		check(!source.some((s) => /skip-?migrations|--no-migrat/i.test(s.text)), `void ${pins.void}'s deploy source has no flag that skips migrations`);
		const voidScan = scanPaths({ roots: [voidHome, path.join(app, '.svelte-kit'), ...['.void', '.void-wrangler.jsonc'].map((f) => path.join(app, f)).filter(existsSync)], canaries: [canaries.token, canaries.clerk], base: runDir });
		l.observed = {
			info: infoJson,
			build: { exit: build.code, workerWritten: built, error: show(/ERR_[A-Z_]+[^\n]{0,160}|Error:[^\n]{0,200}/.exec(build.out)?.[0] ?? '') },
			generatedConfigBindsD1: /d1_databases/.test(generated),
			bundleModules: { drizzle: bundled('drizzle-orm'), betterAuth: bundled('better-auth') },
			configEvaluations: evaluations,
			deployOffline: { exit: deploy.code, network: deploy.network, lastLines: show(deploy.out.trim().split('\n').slice(-4).join(' | ')).slice(0, 600) },
			automaticMigrations: { source: `node_modules/void/dist/${migrates?.f}`, order: 'list pending, save a time-travel bookmark (refuses to migrate without one), apply, list again', skipFlag: 'none found' },
			canaryInVoidOutputs: voidScan.hits,
		};
	});

	await leg('P7-cf-dry-run-offline', 'cf deploy --dry-run --no-provision in a project with a committed config: network, files and exit', (l, check) => {
		const before = snapshot(plain);
		const dry = step(l, 'Node', [tool.cf, 'deploy', '--dry-run', '--no-provision'], { cwd: plain });
		const writes = changed(before, snapshot(plain));
		check(dry.code === 0, 'exit 0');
		check(Array.isArray(dry.network) && dry.network.length === 0, 'no connect or lookup beyond loopback (the only sockets are the local Miniflare type generator)');
		check(writes.every((w) => w.startsWith('.cloudflare/') || w.startsWith('.wrangler/')), 'it writes only its own .cloudflare/ and .wrangler/ state inside the project');
		l.observed = { writes, writeFree: writes.length === 0 };
	});

	await leg('P8-unforced-destructive', 'an unforced destructive command, non-interactive, placeholder account, offline', (l, check) => {
		const env = { CLOUDFLARE_ACCOUNT_ID: PLACEHOLDER_ACCOUNT };
		const results = Object.fromEntries(
			(
				[
					['cf d1 delete', 'Node', [tool.cf, 'd1', 'delete', clientA.d1.id]],
					['cf workers delete', 'Node', [tool.cf, 'workers', 'delete', clientA.worker]],
					['wrangler d1 delete', 'Node', [tool.wrangler, 'd1', 'delete', clientA.d1.name]],
				] as const
			).map(([label, host, cmd]) => {
				const r = step(l, host, [...cmd], { cwd: plain, env });
				return [label, { exit: r.code, aborted: /abort/i.test(r.out), auth: /auth|token|log ?in|credential/i.test(r.out), network: r.network, firstLine: show(r.out.trim().split('\n').find((x) => /\w/.test(x) && !x.includes('AGENT')) ?? '').slice(0, 200) }];
			}),
		);
		check(Object.values(results).every((r) => r.exit !== null), 'each command ran to an exit code');
		l.observed = results;
	});

	await leg('P9-wrong-client', "two clients on one placeholder account: target check and dry runs, and client B's D1 id in client A's config", (l, check) => {
		check(clientA.accountId === clientB.accountId, 'both clients name the same account');
		const reviewed = digestDir(artifact);
		const stageFor = (client: string, name = client) => {
			const out = path.join(runDir, `stage-${name}`);
			const r = step(l, 'Bun', [path.join(root, 'deploy/probes/target.ts'), 'stage', client, '--artifact', artifact, '--digest', reviewed, '--out', out], { cwd: root });
			check(r.code === 0, `target.ts stage ${client} passes the check and stages the reviewed artifact`);
			writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({ name: `stage-${name}`, private: true, type: 'module', devDependencies: { wrangler: pins.wrangler } })}\n`);
			symlinkSync(path.join(HERE, 'node_modules'), path.join(out, 'node_modules'));
			return out;
		};
		const dryRuns = (dir: string) => ({
			cf: step(l, 'Node', [tool.cf, 'deploy', '--dry-run', '--no-provision'], { cwd: dir }),
			wrangler: step(l, 'Node', [tool.wrangler, 'deploy', '--dry-run', '--outdir', path.join(dir, 'wrangler-out'), '-c', 'wrangler.jsonc'], { cwd: dir }),
		});
		const own: Record<string, unknown> = {};
		for (const t of [clientA, clientB]) {
			const other = t === clientA ? clientB : clientA;
			const runs = dryRuns(stageFor(t.client));
			for (const [toolName, r] of Object.entries(runs)) {
				const names = bindingNames(r.out);
				check(r.code === 0, `${toolName} deploy --dry-run of ${t.client}'s stage exits 0`);
				check(JSON.stringify(names) === JSON.stringify([`BUCKET=${t.r2.bucket}`, `CLEARCASE_CLIENT_ID="${t.client}"`, `DB=${t.d1.name}`]), `${toolName}: ${t.client}'s dry run names exactly its own D1, bucket and client`);
				check(![other.worker, other.d1.name, other.d1.id, other.r2.bucket].some((v) => r.out.includes(v)), `${toolName}: ${t.client}'s output names none of ${other.client}'s identifiers`);
				own[`${t.client} ${toolName}`] = names;
			}
		}
		const swapped = stageFor('client-a', 'swapped');
		for (const f of ['cloudflare.config.ts', 'wrangler.jsonc']) writeFileSync(path.join(swapped, f), readFileSync(path.join(swapped, f), 'utf8').replace(clientA.d1.id, clientB.d1.id));
		const refusals = (['cf', 'wrangler'] as const).map((format) => {
			const file = path.join(swapped, format === 'cf' ? 'cloudflare.config.ts' : 'wrangler.jsonc');
			const r = step(l, 'Bun', [path.join(root, 'deploy/probes/target.ts'), 'check', 'client-a', '--format', format, '--config', file], { cwd: root });
			check(r.code === 1 && r.out.includes(`d1 id ${clientB.d1.id} belongs to client-b, not client-a`), `the target check refuses the swapped ${format} config, naming client B`);
			return checkTarget({ client: 'client-a', targets, format, text: readFileSync(file, 'utf8') });
		});
		const swappedRuns = dryRuns(swapped);
		const dryRunAlone = Object.fromEntries(Object.entries(swappedRuns).map(([k, r]) => [k, { exit: r.code, names: bindingNames(r.out), showsForeignId: r.out.includes(clientB.d1.id) }]));
		check(Object.values(dryRunAlone).every((r) => r.exit === 0 && !r.showsForeignId), "the dry runs alone pass the swapped config and never show the foreign D1 id: the manifest check is required");
		l.observed = { account: clientA.accountId, own, refusals, dryRunAlone };
	});

	await leg('janitor-dry-run', 'the disposable-resource janitor against a fake account listing', (l, check) => {
		const dir = path.join(runDir, 'janitor');
		const manifests = path.join(dir, 'cloud-runs');
		mkdirSync(manifests, { recursive: true });
		const now = new Date(startedAt);
		const old = new Date(now.getTime() - 25 * 3_600_000).toISOString();
		writeFileSync(path.join(manifests, 'cc-107-w1-aaaaaaa.json'), JSON.stringify({ schema: 'clearcase.cloud-run/1', name: 'cc-107-w1-aaaaaaa', state: 'finished' }));
		writeFileSync(path.join(manifests, 'cc-108-w3-ccccccc.json'), JSON.stringify({ schema: 'clearcase.cloud-run/1', name: 'cc-108-w3-ccccccc', state: 'open' }));
		const listing = [
			{ kind: 'worker', name: 'cc-107-w1-aaaaaaa', createdAt: old },
			{ kind: 'r2', name: 'cc-109-w2-bbbbbbb', createdAt: old },
			{ kind: 'd1', name: 'cc-108-w3-ccccccc', createdAt: old },
			{ kind: 'd1', name: 'cc-110-w1-ddddddd', createdAt: now.toISOString() },
			{ kind: 'worker', name: clientA.worker, createdAt: old },
			{ kind: 'r2', name: 'cc-prod-files', createdAt: old },
		];
		const file = path.join(dir, 'listing.json');
		writeFileSync(file, JSON.stringify(listing));
		const name = step(l, 'Bun', [path.join(root, 'deploy/probes/cloud-run.ts'), 'name', '--ticket', '107', '--worker', 'w1', '--sha', sha], { cwd: root });
		check(name.code === 0 && name.out.trim() === `cc-107-w1-${sha.slice(0, 7)}`, `this run's resources would be named cc-107-w1-${sha.slice(0, 7)}`);
		const r = step(l, 'Bun', [path.join(root, 'deploy/probes/cloud-run.ts'), 'janitor', '--listing', file, '--manifests', manifests, '--now', now.toISOString()], { cwd: root });
		const lines = r.out.trim().split('\n');
		check(r.code === 0 && lines.at(-1) === 'JANITOR DRY RUN: 2 to delete, 4 kept, nothing deleted', 'the dry run plans 2 deletions, keeps 4 and deletes nothing');
		check(lines.includes(`would delete worker cc-107-w1-aaaaaaa (created ${old})`) && lines.includes(`would delete r2 cc-109-w2-bbbbbbb (created ${old})`), 'it would delete only the finished run and the orphan, both older than 24 hours');
		check(lines.some((x) => x.startsWith(`keep worker ${clientA.worker}: not a run name`)) && lines.some((x) => x.startsWith('keep r2 cc-prod-files: not a run name')), 'it never touches an unprefixed or malformed name');
		check(readFileSync(file, 'utf8') === JSON.stringify(listing), 'the listing is unchanged');
		l.observed = { plan: lines };
	});

	await leg('credential-scan', 'no canary or credential shape in build artifacts, staged deploy inputs, logs or homes', (l, check) => {
		const roots = [path.join(kit, '.svelte-kit'), artifact, logs, home, ...readdirSync(runDir).filter((d) => d.startsWith('stage-')).map((d) => path.join(runDir, d)), path.join(plain, '.cloudflare')].filter(existsSync);
		const values = [canaries.token, canaries.clerk];
		const control = path.join(runDir, 'control');
		mkdirSync(control);
		writeFileSync(path.join(control, 'planted.txt'), `CLOUDFLARE_API_TOKEN=${canaries.token}\n`);
		const planted = scanPaths({ roots: [control], canaries: values, base: runDir });
		check(planted.hits.some((h) => h.rule === 'canary-1'), 'the scan finds a canary planted on purpose (it is not blind)');
		const result = scanPaths({ roots, canaries: values, base: runDir });
		check(result.files > 0, 'the scan read the artifacts and logs');
		check(result.hits.length === 0, `no canary or credential shape in ${result.files} files: ${JSON.stringify(result.hits).slice(0, 300)}`);
		l.observed = { roots: roots.map((r) => show(r)), files: result.files, hits: result.hits, control: planted.hits };
	});

	const endSha = head();
	const clean = !dirty();
	const failed = Object.entries(legs).filter(([, l]) => l.status !== 'PASS').map(([id]) => id);
	const summary = {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: clean && endSha === sha,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: process.versions.bun, node: node.version, runner: `Bun ${BUN}`, appBuild: `Bun ${BUN}`, tools: `Node ${node.version} (cf, Wrangler, Void, Vitest)`, app: `workerd ${pins.workerd} (native, local)` },
		pins,
		isolation: { network: isolation, env: Object.keys(baseEnv).sort() },
		legs,
		hold: HOLD,
		evidence: failed.length === 0 && clean && endSha === sha,
	};
	mkdirSync(path.dirname(out), { recursive: true });
	const text = show(`${JSON.stringify(summary, null, 2)}\n`).replaceAll(path.dirname(root), '<workspace>');
	writeFileSync(out, text);
	const own = scanPaths({ roots: [out], canaries: [canaries.token, canaries.clerk] });
	if (own.hits.length) {
		writeFileSync(out, text.replace('"evidence": true', '"evidence": false'));
		console.log(`FAIL  the summary itself holds ${own.hits.map((h) => h.rule).join(', ')}`);
	}
	if (!clean || endSha !== sha) console.log(`FAIL  tree changed during the run (HEAD ${endSha.slice(0, 12)}, clean ${clean})`);
	const evidence = summary.evidence && own.hits.length === 0;
	console.log(`${evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} legs: ${Object.keys(legs).length - failed.length}/${Object.keys(legs).length} PASS${failed.length ? ` (failed: ${failed.join(', ')})` : ''} summary: ${path.relative(root, out)}`);
	return evidence ? 0 : 1;
}

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

const { values } = parseArgs({ options: { out: { type: 'string' }, inside: { type: 'boolean' } } });
try {
	if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
	const out = path.resolve(values.out ?? path.join(repo(), '.local/hosting-probe/deployment/summary.json'));
	if (!values.inside) process.exit(enterOffline(['--out', out]));
	if (process.env.CLEARCASE_OFFLINE !== '1') throw new Refusal('--inside runs only under tests/e2e/pilot/offline.sh');
	process.exit(await main(out));
} catch (e) {
	if (!(e instanceof Refusal)) throw e;
	console.error(`PROBE REFUSED: ${e.message}`);
	process.exit(2);
}
