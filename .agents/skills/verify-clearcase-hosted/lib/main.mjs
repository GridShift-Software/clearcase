// verify-clearcase-hosted: the hosted lifecycle of ClearCase on local workerd, offline, with evidence.
// Invoked by ../bin/verify-clearcase-hosted; see ../SKILL.md. `gate:hosted` runs the same lifecycle (hostedRun) with
// its extra checks. Subcommands:
//   run [--keep-scratch]  preflight, then in one offline namespace: build:hosted, start:hosted, live doctor, drive, stop; cleanup
//   preflight             the local checks only; never builds, starts or connects to anything
//   live-doctor --port N  check the hosted-gate server this worktree's start:hosted runs on port N (its state file)
//   cleanup [--run-id ID] stop this skill's server port, kill the PIDs a run recorded (only while they run from its scratch), remove scratch
//   features              print the feature index found by discovery (features/*.md, lib/steps.mjs); exit 1 on a breach
// Exit: 0 PASS; 1 a step failed; 2 usage; 3 SKIPPED, a prerequisite is missing (nothing was built or started).
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { formatDoctor, liveDoctor } from './doctor.mjs';
import { DRIVE_STEPS, innerProblem, PROFILE } from './evidence.mjs';
import { featureIndex, formatIndex } from './features.mjs';

export const SKILL = resolve(import.meta.dirname, '..');
export const REPO = resolve(SKILL, '..', '..', '..');
const HARNESS = join(REPO, 'tests', 'e2e', 'pilot');
const HARNESS_FILES = ['offline.sh', 'lib/netproof.mjs', 'lib/cdp.mjs', 'lib/canary.mjs', 'suite/context.mjs'];
export const FIXTURE_MODULE = join(REPO, 'tests', 'hosted-foundation', 'runtime', 'gate-fixture.ts');
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const env = process.env;
export const CHROME = env.CLEARCASE_CHROMIUM ?? `${env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;
/** The steps every complete run passes, in order (the gate inserts its checks among them). */
export const LIFECYCLE = ['net-offline', 'build', 'start', 'live-doctor', 'live-doctor-negative', 'browser', ...DRIVE_STEPS, 'drive', 'stop'];

export const reportRoot = () => (env.CLEARCASE_REPORT_DIR ? join(resolve(env.CLEARCASE_REPORT_DIR), 'hosted') : join(REPO, '.local', 'verify-clearcase-hosted'));
export const scratchRoot = () => resolve(env.CLEARCASE_HOSTED_SCRATCH ?? join(REPO, '.local', 'verify-clearcase-hosted-scratch'));
export function ports(base = Number(env.VERIFY_CLEARCASE_HOSTED_PORT ?? 43700)) {
	return { app: base, canary: Number(env.CANARY_PORT ?? base + 99) };
}
export const runId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const systemTool = (name) => [...(env.PATH ?? '').split(delimiter), ...SYSTEM_PATH.split(':')].filter(Boolean).map((d) => join(d, name)).find(executable) ?? null;
const git = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8' });
const flags = (argv) => { const o = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; } return o; };

/** The first `node` on PATH that is really Node, not Bun's `bun run --bun` stand-in: Wrangler needs Node. */
export function realNode() {
	for (const dir of (env.PATH ?? '').split(delimiter)) {
		const candidate = join(dir, 'node');
		if (!executable(candidate)) continue;
		const r = spawnSync(candidate, ['-p', 'JSON.stringify([process.versions.node, process.versions.bun ?? null])'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
		if (r.status !== 0) continue;
		const [node, bun] = JSON.parse(r.stdout);
		if (bun === null) return { path: candidate, version: node };
	}
	return null;
}

/** Local checks only (files, versions, `unshare -rn true`): no build, no listener, no network. */
export function preflight({ port = ports() } = {}) {
	const problems = [], facts = { repo: REPO };
	const need = (ok, what, fix) => { if (!ok) problems.push(`${what}; fix: ${fix}`); return ok; };
	const head = git('rev-parse', '--verify', '-q', 'HEAD^{commit}');
	if (need(head.status === 0, `${REPO} has no HEAD commit`, 'run from a ClearCase checkout or worktree')) facts.revision = head.stdout.trim();
	const status = git('status', '--porcelain', '--untracked-files=all');
	need(status.status === 0 && status.stdout === '', `the tree is dirty (${status.stdout.split('\n').filter(Boolean).slice(0, 3).join('; ')})`, 'commit or stash first: build:hosted stamps HEAD and start:hosted refuses a dirty tree');
	const pin = /^bun@(\d+\.\d+\.\d+)$/.exec(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).packageManager ?? '')?.[1];
	facts.bun = { path: process.execPath, version: process.versions.bun ?? null, pin };
	need(pin && process.versions.bun === pin, `this Bun is ${process.versions.bun} at ${process.execPath}, the packageManager pin is ${pin}`, `run with Bun ${pin} (set CLEARCASE_BUN)`);
	const missing = ['wrangler', 'workerd', '@sveltejs/kit', '@sveltejs/adapter-cloudflare', 'vite'].filter((p) => !existsSync(join(REPO, 'node_modules', p, 'package.json')));
	need(!missing.length, `node_modules lacks ${missing.join(', ')}`, `cd ${REPO} && bun install --frozen-lockfile`);
	for (const f of HARNESS_FILES) need(existsSync(join(HARNESS, f)), `harness file tests/e2e/pilot/${f} is missing`, 'run from a checkout with the e2e harness');
	const node = realNode();
	facts.node = node;
	if (need(node, 'no real Node on PATH (`node` under `bun run --bun` is Bun)', 'install Node >= 22 and put it on PATH: Node hosts Wrangler'))
		need(Number(node.version.split('.')[0]) >= 22, `Node ${node.version} at ${node.path} is older than 22`, 'install Node >= 22 (Wrangler 4 needs it)');
	const unshare = systemTool('unshare'), ip = systemTool('ip'), mount = systemTool('mount');
	facts.tools = { unshare, ip, mount, chromium: CHROME };
	if (need(unshare, 'unshare (util-linux) not found', 'install util-linux'))
		need(spawnSync(unshare, ['-rn', systemTool('true') ?? '/bin/true']).status === 0, `\`${unshare} -rn true\` failed: unprivileged user and network namespaces are unavailable`, 'enable them (sysctl kernel.unprivileged_userns_clone=1)');
	need(ip, 'ip (iproute2) not found', 'install iproute2');
	need(mount, 'mount (util-linux) not found', 'install util-linux');
	need(executable(CHROME), `Chromium not found at ${CHROME}`, 'set CLEARCASE_CHROMIUM, or install the Playwright build at ~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
	const lock = env.CLEARCASE_BROWSER_LOCK || null;
	facts.lock = lock;
	if (lock) need(lock.startsWith('/') && executable(lock), `CLEARCASE_BROWSER_LOCK=${lock} is not an absolute path to an executable`, 'point it at orch-bin/browser-lock by absolute path, or unset it');
	facts.ports = port;
	need([port.app, port.canary].every((n) => Number.isInteger(n) && n >= 1024 && n <= 65535) && port.app !== port.canary, `ports ${JSON.stringify(port)} are not distinct integers in 1024-65535`, 'set VERIFY_CLEARCASE_HOSTED_PORT and CANARY_PORT');
	return { ok: !problems.length, problems, facts };
}

const alive = (pid) => { try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };

/**
 * Stops the run's server through its own pid file (`start:hosted --stop`, same PORT), kills only recorded PIDs that
 * still run from this run's scratch, drops the port's state file when the process it names is gone, and removes the
 * scratch. Evidence is never touched.
 */
export function cleanupRun(scratch, port) {
	const out = { scratch, port, killed: [], survivors: [], removed: false };
	const pidFile = join(REPO, '.local', 'hosted', `start-${port}.pid`), stateFile = join(REPO, '.local', 'hosted', `server-${port}.json`);
	if (existsSync(pidFile)) {
		const r = spawnSync(process.execPath, ['run', '--bun', 'start:hosted', '--stop'], { cwd: REPO, encoding: 'utf8', env: { ...env, PORT: String(port) } });
		out.stop = `${r.status}: ${`${r.stdout}${r.stderr}`.trim().split('\n').at(-1)}`;
	}
	if (existsSync(stateFile)) {
		let pid = null;
		try { pid = JSON.parse(readFileSync(stateFile, 'utf8')).pid; } catch {}
		if (pid && alive(pid)) out.survivors.push({ role: 'start-hosted', pid });
		else { rmSync(stateFile, { force: true }); out.staleState = 'removed'; }
	}
	const file = join(scratch, 'pids.jsonl');
	const recorded = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	const ours = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(scratch); } catch { return false; } };
	for (const sig of ['SIGTERM', 'SIGKILL']) {
		for (const r of recorded) if (ours(r.pid)) { try { process.kill(r.pid, sig); out.killed.push({ ...r, sig }); } catch {} }
		const until = Date.now() + 3000;
		while (recorded.some((r) => ours(r.pid)) && Date.now() < until) spawnSync('sleep', ['0.05']);
	}
	out.survivors.push(...recorded.filter((r) => ours(r.pid)));
	if (!out.survivors.length) { rmSync(scratch, { recursive: true, force: true }); out.removed = !existsSync(scratch); }
	return out;
}

/**
 * One hosted run: the offline namespace runs inner.mjs (build, `checks` at their phase, start, live doctor, drive,
 * stop), then cleanup and the evidence-kept check. `checks`: [{ id, title, at: 'build' | 'server', cmd, cwd?, env?, summary? }].
 * Returns { ok, steps, inner }; `steps` is every step in order with PASS, FAIL or NOT RUN.
 */
export async function hostedRun({ revision, evidence, scratch, port, checks = [], node, tools, lock = env.CLEARCASE_BROWSER_LOCK || null, keepScratch = false, log = (s) => process.stdout.write(s) }) {
	mkdirSync(evidence, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	const steps = [];
	const cfg = { repo: REPO, revision, ports: port, evidence, harness: join(HARNESS, 'lib'), fixtureModule: FIXTURE_MODULE, profileDir: join(scratch, 'profile'), pidFile: join(scratch, 'pids.jsonl'), app: `http://127.0.0.1:${port.app}`, lock, checks };
	writeFileSync(join(scratch, 'config.json'), JSON.stringify(cfg, null, 1));
	const pathDirs = [...new Set([dirname(process.execPath), dirname(node.path), dirname(tools.unshare), dirname(tools.ip), dirname(tools.mount), ...SYSTEM_PATH.split(':')])].join(delimiter);
	// The namespace sees this allowlist only: no proxy, token, account or cloud variable of the caller reaches it.
	const keep = ['HOME', 'TMPDIR', 'LANG', 'CI', 'CLEARCASE_CHROMIUM', 'CLEARCASE_BROWSER_SLOT', 'CLEARCASE_HOSTED_GATE_LEADER'];
	const childEnv = { PATH: pathDirs, ...Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])) };
	const argv = ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(HARNESS, 'offline.sh'), process.execPath, join(SKILL, 'lib', 'inner.mjs'), join(scratch, 'config.json')];
	const t0 = Date.now();
	const child = spawn(tools.unshare, argv, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
	writeFileSync(cfg.pidFile, JSON.stringify({ role: 'offline-namespace', pid: child.pid, at: new Date().toISOString() }) + '\n', { flag: 'a' });
	const chunks = [];
	for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { log(d.toString()); chunks.push(d); });
	const limit = Number(env.VERIFY_CLEARCASE_HOSTED_TIMEOUT_MS ?? 5_400_000);
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; chunks.push(Buffer.from(`\nverify-clearcase-hosted: the offline run exceeded ${limit} ms; killing pid ${child.pid}\n`)); child.kill('SIGKILL'); }, limit);
	const exit = await new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
	clearTimeout(timer);
	writeFileSync(join(evidence, 'offline.log'), Buffer.concat(chunks));
	const innerFile = join(evidence, 'inner.json');
	const inner = existsSync(innerFile) ? JSON.parse(readFileSync(innerFile, 'utf8')) : null;
	steps.push(...(inner?.results ?? []));
	const required = [...LIFECYCLE, ...checks.map((c) => c.id)];
	const problem = exit.code !== 0 ? `the offline namespace exited ${JSON.stringify(exit)}${timedOut ? ` (killed after ${limit} ms)` : ''}; see offline.log` : innerProblem(inner, revision, required);
	steps.push({ id: 'offline', title: 'the offline namespace finished and inner.json records every required step as PASS', status: problem ? 'FAIL' : 'PASS', ms: Date.now() - t0, error: problem ?? undefined, evidence: { command: [tools.unshare, ...argv], exit } });
	const c = keepScratch ? { kept: scratch } : cleanupRun(scratch, port.app);
	const cleaned = keepScratch || (c.removed && !c.survivors.length);
	steps.push({ id: 'cleanup', title: 'stop the run\'s server port; kill only recorded PIDs still running from this run\'s scratch; remove scratch', status: cleaned ? 'PASS' : 'FAIL', evidence: c });
	const ran = (id) => steps.some((s) => s.id === id && s.status !== 'NOT RUN');
	const passed = (id) => steps.some((s) => s.id === id && s.status === 'PASS');
	const want = [['offline.log', true], ['inner.json', ran('net-offline')], ['clearcase-hosted.json', passed('build')], ['server.log', ran('start')], ['health.json', ran('live-doctor')], ['drive.json', ran('drive')]].filter(([, w]) => w).map(([f]) => f);
	const shots = steps.filter((s) => s.status === 'PASS').flatMap((s) => Object.values(s.evidence ?? {}).filter((v) => typeof v === 'string' && /^(screens|downloads)\//.test(v)));
	const lost = [...want, ...shots].filter((f) => !existsSync(join(evidence, f)));
	const kept = !lost.length && (problem || shots.length >= 5);
	steps.push({ id: 'evidence-kept', title: 'the evidence exists after cleanup', status: kept ? 'PASS' : 'FAIL', evidence: { dir: evidence, files: want, screens: shots }, error: lost.length ? `missing after cleanup: ${lost.join(', ')}` : kept ? undefined : `only ${shots.length} screenshots` });
	return { ok: !problem && cleaned && kept, steps, inner };
}

const table = (steps) => steps.map((s) => `${(s.status ?? '').padEnd(8)}${s.id.padEnd(22)}${s.ms === undefined ? '' : `${String(Math.round(s.ms / 1000)).padStart(3)}s  `}${s.title ?? ''}${s.error ? `\n        ${String(s.error).split('\n')[0].slice(0, 400)}` : ''}`).join('\n');

async function cmdRun(o) {
	const id = runId(), evidence = join(reportRoot(), id), scratch = join(scratchRoot(), id), port = ports();
	mkdirSync(evidence, { recursive: true });
	const summary = { schema: 'verify-clearcase-hosted/1', runId: id, evidence, scratch, startedAt: new Date().toISOString(), profile: PROFILE };
	const finish = (code, steps) => {
		Object.assign(summary, { steps, result: code === 0 ? 'PASS' : code === 3 ? 'SKIPPED' : 'FAIL', exitCode: code, finishedAt: new Date().toISOString() });
		writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
		console.log(`\n${table(steps)}\nverify-clearcase-hosted: ${summary.result} (exit ${code}). Evidence: ${evidence}`);
		return code;
	};
	console.log(`verify-clearcase-hosted run ${id}\n  evidence ${evidence}\n  scratch  ${scratch}`);
	const pre = preflight({ port });
	summary.preflight = pre.facts;
	if (!pre.ok) {
		console.error(`verify-clearcase-hosted: SKIPPED preflight. Nothing was built, started or contacted:\n  - ${pre.problems.join('\n  - ')}`);
		return finish(3, [{ id: 'preflight', status: 'SKIPPED', error: pre.problems.join('\n        ') }]);
	}
	const ix = featureIndex();
	summary.features = ix.features;
	const head = [{ id: 'preflight', title: 'clean tree, Bun pin, dependencies, real Node, namespaces, Chromium, ports', status: 'PASS' }, { id: 'features', title: 'feature files keep the entry contract; every drive step names its feature', status: ix.ok ? 'PASS' : 'FAIL', error: ix.ok ? undefined : ix.problems.join('\n        ') }];
	if (!ix.ok) return finish(1, head);
	const r = await hostedRun({ revision: pre.facts.revision, evidence, scratch, port, node: pre.facts.node, tools: pre.facts.tools, lock: pre.facts.lock, keepScratch: !!o['keep-scratch'] });
	return finish(r.ok ? 0 : 1, [...head, ...r.steps]);
}

async function cmdLiveDoctor(o) {
	const port = Number(o.port);
	const stateFile = join(REPO, '.local', 'hosted', `server-${port}.json`);
	if (!port || !existsSync(stateFile)) { console.error(`usage: verify-clearcase-hosted live-doctor --port N (a hosted-gate server this worktree's start:hosted runs; ${stateFile} must exist)`); return 2; }
	const state = JSON.parse(readFileSync(stateFile, 'utf8')), sidecar = JSON.parse(readFileSync(join(REPO, '.svelte-kit', 'clearcase-hosted.json'), 'utf8'));
	const { gateFixture } = await import(FIXTURE_MODULE);
	const r = await liveDoctor({ url: state.base, expect: { revision: git('rev-parse', 'HEAD').stdout.trim(), buildId: sidecar.stamp.buildId, profile: PROFILE, runId: state.runId, fixtureSha256: gateFixture().sha256, pid: state.pid, persist: join(REPO, state.persist) } });
	console.log(`${formatDoctor(r)}\nlive-doctor: ${r.pass ? 'PASS' : 'FAIL'}`);
	return r.pass ? 0 : 1;
}

function cmdCleanup(o) {
	const root = scratchRoot();
	const ids = o['run-id'] ? [o['run-id']] : existsSync(root) ? readdirSync(root) : [];
	let bad = 0;
	for (const id of ids) {
		const r = cleanupRun(join(root, id), ports().app);
		if (r.survivors.length || !r.removed) bad++;
		console.log(`${r.removed ? 'removed ' : 'KEPT    '} ${r.scratch}: killed ${r.killed.length}, survivors ${r.survivors.map((s) => s.pid).join(' ') || 'none'}`);
	}
	console.log(`cleanup: ${ids.length} run(s) under ${root}; evidence under ${reportRoot()} untouched.`);
	return bad ? 1 : 0;
}

if (import.meta.main) {
	const [cmd = 'run', ...rest] = process.argv.slice(2);
	const o = flags(rest);
	const commands = {
		run: () => cmdRun(o),
		preflight: () => { const r = preflight(); console.log(JSON.stringify(r.facts, null, 1)); if (!r.ok) console.error(`verify-clearcase-hosted: SKIPPED preflight:\n  - ${r.problems.join('\n  - ')}`); else console.log('preflight: PASS'); return r.ok ? 0 : 3; },
		'live-doctor': () => cmdLiveDoctor(o),
		cleanup: () => cmdCleanup(o),
		features: () => { const ix = featureIndex(); console.log(formatIndex(ix)); return ix.ok ? 0 : 1; },
	};
	if (cmd === '--help' || cmd === 'help' || !commands[cmd]) {
		console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
		process.exit(commands[cmd] || cmd === '--help' || cmd === 'help' ? 0 : 2);
	}
	process.exit(await commands[cmd]());
}
