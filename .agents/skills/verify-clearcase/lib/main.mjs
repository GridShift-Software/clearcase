// verify-clearcase: the whole verification lifecycle of the ClearCase pilot, offline, with evidence.
// Invoked by ../bin/verify-clearcase; see ../SKILL.md. Subcommands:
//   run [--rev REV]      preflight, isolated build, offline boot, live doctor, drive, cleanup (the default)
//   preflight [--rev REV]   the local checks only; never builds, starts or connects to anything
//   live-doctor --url URL --pid PID --data-dir DIR --build-stamp FILE [--originals-port N] [--bun VERSION]
//   cleanup [--run-id ID]   kill the PIDs a run recorded (only if they still run from its scratch) and remove scratch
//   features             print the feature index found by discovery (features/*.md and *.steps.mjs); exit 1 on a breach
//   self-test            clean-checkout preflight, stale/wrong-build live doctor and feature index cases
// Exit: 0 PASS; 1 a step failed; 2 usage; 3 SKIPPED, a prerequisite is missing (nothing was built or started).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { formatDoctor, liveDoctor } from './live-doctor.mjs';
import { pilotSteps } from './drive.mjs';
import { featureIndex, formatIndex } from './features.mjs';
import { gitEnv } from '../../../../scripts/browser-lock.mjs';

export const SKILL = resolve(import.meta.dirname, '..');
export const REPO = resolve(SKILL, '..', '..', '..');
const HARNESS = join(REPO, 'tests', 'e2e', 'pilot');
const HARNESS_FILES = ['offline.sh', 'lib/netproof.mjs', 'lib/server.mjs', 'lib/cdp.mjs', 'lib/canary.mjs', 'lib/client.mjs', 'lib/isolated-build.mjs', 'lib/fixtures.ts', 'suite/context.mjs'];
const env = process.env;
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export const CHROME = env.CLEARCASE_CHROMIUM ?? `${env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;
export const reportRoot = () => (env.CLEARCASE_REPORT_DIR ? join(resolve(env.CLEARCASE_REPORT_DIR), 'skill') : join(REPO, '.local', 'verify-clearcase'));
export const scratchRoot = () => resolve(env.VERIFY_CLEARCASE_SCRATCH ?? join(REPO, '.local', 'verify-clearcase-scratch'));
export function ports() {
	const base = Number(env.VERIFY_CLEARCASE_PORT ?? 43600);
	return { app: base, originals: base + 1, canary: Number(env.CANARY_PORT ?? base + 99), selfTest: base + 50 };
}
const runId = (prefix = '') => `${prefix}${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
/** A system tool from PATH, else from the standard system directories (ip often lives in /usr/sbin). */
export const systemTool = (name) => [...(env.PATH ?? '').split(delimiter), ...SYSTEM_PATH.split(':')].filter(Boolean).map((d) => join(d, name)).find(executable) ?? null;
const git = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8', env: gitEnv() });
const flags = (argv) => { const o = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; } return o; };

/** Local checks only (files, versions, `unshare -rn true`): no build, no listener, no network. */
export function preflight({ rev = 'HEAD' } = {}) {
	const problems = [], facts = { repo: REPO, rev };
	const need = (ok, what, fix) => { if (!ok) problems.push(`${what}; fix: ${fix}`); return ok; };
	const head = git('rev-parse', '--verify', '-q', `${rev}^{commit}`);
	if (need(head.status === 0, `${REPO} has no commit ${rev} (${(head.stderr || 'not a git checkout').trim()})`, 'run from a ClearCase checkout or worktree, or pass --rev REV naming a commit'))
		facts.revision = head.stdout.trim();
	const pkg = facts.revision ? git('show', `${facts.revision}:package.json`) : null;
	const pin = pkg?.status === 0 ? /^bun@(\d+\.\d+\.\d+)/.exec(JSON.parse(pkg.stdout).packageManager ?? '')?.[1] : null;
	facts.bunPin = pin;
	facts.bun = { path: process.execPath, version: process.versions.bun ?? null };
	if (need(pin, `package.json at ${rev} pins no bun@MAJOR.MINOR.PATCH packageManager`, 'build a revision of the Bun app (GRS-10 or later)'))
		need(process.versions.bun === pin, `this Bun is ${process.versions.bun} at ${process.execPath}, the packageManager pin is ${pin}`, `run with Bun ${pin} (set CLEARCASE_BUN), or move the pin as AGENTS.md describes`);
	const lock = join(REPO, 'bun.lock'), nm = join(REPO, 'node_modules');
	const installed = ['vite', '@sveltejs/kit', '@sveltejs/adapter-node', 'pdfjs-dist', 'svelte'].filter((p) => !existsSync(join(nm, p, 'package.json')));
	need(existsSync(nm) && !installed.length, `${nm} is ${existsSync(nm) ? `missing ${installed.join(', ')}` : 'missing'} (a clean checkout has no installed dependencies)`, `cd ${REPO} && bun install --frozen-lockfile`);
	if (facts.revision && existsSync(lock)) {
		const at = git('show', `${facts.revision}:bun.lock`);
		need(at.status === 0 && createHash('sha256').update(at.stdout).digest('hex') === sha(lock), `bun.lock at ${facts.revision.slice(0, 12)} differs from the installed ${lock}`, `check out ${rev} and run bun install --frozen-lockfile, or pass --rev with the installed lockfile`);
	} else need(existsSync(lock), `${lock} is missing`, 'restore bun.lock from the revision');
	for (const f of HARNESS_FILES) need(existsSync(join(HARNESS, f)), `harness file tests/e2e/pilot/${f} is missing`, 'run the skill from a checkout at or after the GRS-12 e2e harness commit');
	const unshare = systemTool('unshare'), ip = systemTool('ip'), mount = systemTool('mount');
	facts.tools = { unshare, ip, mount, chromium: CHROME };
	if (need(unshare, 'unshare (util-linux) not found', 'pacman -S util-linux'))
		need(spawnSync(unshare, ['-rn', systemTool('true') ?? '/bin/true']).status === 0, `\`${unshare} -rn true\` failed: unprivileged user and network namespaces are unavailable`, 'enable them (sysctl kernel.unprivileged_userns_clone=1)');
	need(ip, 'ip (iproute2) not found', 'pacman -S iproute2');
	need(mount, 'mount (util-linux) not found', 'pacman -S util-linux');
	need(executable(CHROME), `Chromium not found at ${CHROME}`, 'set CLEARCASE_CHROMIUM to a Chromium binary, or install the Playwright build at ~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
	const p = ports();
	facts.ports = p;
	need([p.app, p.originals, p.canary, p.selfTest].every((n) => Number.isInteger(n) && n >= 1024 && n <= 65535) && new Set([p.app, p.originals, p.canary]).size === 3,
		`ports ${JSON.stringify(p)} are not distinct integers in 1024-65535`, 'set VERIFY_CLEARCASE_PORT (default 43600) and CANARY_PORT (default its +99) inside 43600-43699');
	return { ok: !problems.length, problems, facts };
}

/** Kill only PIDs this run recorded that still run from its scratch directory; then remove that directory. */
export function cleanupRun(scratch) {
	const out = { scratch, killed: [], gone: [], survivors: [], removed: false };
	const file = join(scratch, 'pids.jsonl');
	const recorded = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	const ours = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(scratch); } catch { return false; } };
	for (const sig of ['SIGTERM', 'SIGKILL']) {
		for (const r of recorded) if (ours(r.pid)) { try { process.kill(r.pid, sig); out.killed.push({ ...r, sig }); } catch { /* exited meanwhile */ } }
		const until = Date.now() + 3000;
		while (recorded.some((r) => ours(r.pid)) && Date.now() < until) spawnSync('sleep', ['0.05']);
	}
	for (const r of recorded) (ours(r.pid) ? out.survivors : out.gone).push(r);
	if (!out.survivors.length) { rmSync(scratch, { recursive: true, force: true }); out.removed = !existsSync(scratch); }
	return out;
}

function table(steps) { return steps.map((s) => `${(s.status ?? '').padEnd(8)}${s.id.padEnd(22)}${s.title ?? ''}${s.error ? `\n        ${String(s.error).split('\n')[0].slice(0, 400)}` : ''}`).join('\n'); }

async function run(o) {
	const id = runId();
	const evidence = join(reportRoot(), id), scratch = join(scratchRoot(), id);
	mkdirSync(evidence, { recursive: true });
	const started = new Date().toISOString();
	const steps = [];
	const summary = { schema: 'verify-clearcase/1', runId: id, evidence, scratch, startedAt: started, steps };
	const finish = (code) => {
		summary.result = code === 0 ? 'PASS' : code === 3 ? 'SKIPPED' : 'FAIL';
		summary.exitCode = code;
		summary.finishedAt = new Date().toISOString();
		writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
		console.log(`\n${table(steps)}\nverify-clearcase: ${summary.result} (exit ${code}). Evidence: ${evidence}`);
		return code;
	};
	const notRun = (...names) => names.forEach((n) => steps.push({ id: n, status: 'NOT RUN' }));
	console.log(`verify-clearcase run ${id}\n  evidence ${evidence}\n  scratch  ${scratch}`);

	const pre = preflight({ rev: o.rev ?? 'HEAD' });
	summary.preflight = pre.facts;
	steps.push({ id: 'preflight', title: 'tools, Bun pin, installed dependencies, harness, ports', status: pre.ok ? 'PASS' : 'SKIPPED', error: pre.ok ? undefined : pre.problems.join('\n        ') });
	if (!pre.ok) {
		console.error(`verify-clearcase: SKIPPED preflight. Nothing was built, started or contacted:\n  - ${pre.problems.join('\n  - ')}`);
		notRun('isolated-build', 'offline', 'cleanup');
		return finish(3);
	}
	// the feature index by discovery: every feature file keeps the entry contract and every drive step is valid
	const ix = await featureIndex(pilotSteps);
	summary.features = ix.features;
	summary.featureModules = ix.modules;
	steps.push({ id: 'features', title: 'feature files keep the entry contract; drive steps (lib/drive.mjs, features/*.steps.mjs) are valid', status: ix.ok ? 'PASS' : 'FAIL',
		evidence: { features: ix.features.map((f) => f.id), modules: ix.modules }, error: ix.ok ? undefined : ix.problems.join('\n        ') });
	if (!ix.ok) {
		notRun('isolated-build', 'offline', 'cleanup');
		return finish(1);
	}
	const { revision, bunPin, tools } = pre.facts;
	const p = pre.facts.ports;
	mkdirSync(scratch, { recursive: true });
	let code = 0;
	try {
		// 1. a fresh production build of the exact revision, outside the worktree's own build/
		const t0 = Date.now();
		let built;
		try {
			const { isolatedBuild } = await import(join(HARNESS, 'lib', 'isolated-build.mjs'));
			built = isolatedBuild({ repo: REPO, rev: revision, dir: scratch, log: (m) => console.log(m) });
			const s = built.stamp;
			if (s.revision !== revision || s.exported !== true || s.dirty !== false || !/^[0-9a-f]{16}$/.test(s.buildId)) throw new Error(`build stamp does not name ${revision}: ${JSON.stringify(s)}`);
			writeFileSync(join(evidence, 'clearcase-build.json'), JSON.stringify(s, null, 1) + '\n');
			steps.push({ id: 'isolated-build', title: `git archive ${revision.slice(0, 12)}, reflinked node_modules, bun run --bun build`, status: 'PASS', ms: Date.now() - t0, evidence: { stamp: s, lockSha256: built.lockSha256 } });
		} catch (e) {
			steps.push({ id: 'isolated-build', status: 'FAIL', ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 4000) });
			notRun('offline');
			throw Object.assign(new Error('build'), { quiet: true });
		}
		// 2. boot, live doctor and drive inside the offline namespace
		const cfg = {
			harness: join(HARNESS, 'lib'), src: built.src, buildDir: built.buildDir, stamp: built.stamp, bunPin, revision, ports: p,
			fixtures: existsSync(join(built.src, 'tests/e2e/pilot/lib/fixtures.ts')) ? join(built.src, 'tests/e2e/pilot/lib/fixtures.ts') : join(HARNESS, 'lib/fixtures.ts'),
			dataDir: join(scratch, 'data'), profileDir: join(scratch, 'profile'), caseRoot: join(scratch, 'case'), evidence, pidFile: join(scratch, 'pids.jsonl'),
		};
		writeFileSync(join(scratch, 'config.json'), JSON.stringify(cfg, null, 1));
		const t1 = Date.now();
		const pathDirs = [...new Set([dirname(process.execPath), dirname(tools.unshare), dirname(tools.ip), dirname(tools.mount), ...(env.PATH ?? '').split(delimiter), '/usr/bin', '/bin'])].filter(Boolean).join(delimiter);
		const argv = ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(HARNESS, 'offline.sh'), process.execPath, join(SKILL, 'lib', 'inner.mjs'), join(scratch, 'config.json')];
		const child = spawn(tools.unshare, argv, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: pathDirs, HOME: env.HOME, CANARY_PORT: String(p.canary), ...(env.CLEARCASE_CHROMIUM ? { CLEARCASE_CHROMIUM: env.CLEARCASE_CHROMIUM } : {}) } });
		writeFileSync(join(scratch, 'pids.jsonl'), JSON.stringify({ role: 'offline-namespace', pid: child.pid, at: new Date().toISOString() }) + '\n', { flag: 'a' });
		const log = [];
		for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { process.stdout.write(d); log.push(d); });
		const limit = Number(env.VERIFY_CLEARCASE_TIMEOUT_MS ?? 300000);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; log.push(Buffer.from(`\nverify-clearcase: offline run exceeded ${limit} ms; killing pid ${child.pid}\n`)); child.kill('SIGKILL'); }, limit);
		const exit = await new Promise((r) => child.on('exit', (c, sig) => r({ code: c, sig })));
		clearTimeout(timer);
		writeFileSync(join(evidence, 'offline.log'), Buffer.concat(log));
		const inner = existsSync(join(evidence, 'inner.json')) ? JSON.parse(readFileSync(join(evidence, 'inner.json'), 'utf8')) : null;
		summary.offline = { command: [tools.unshare, ...argv], exit, ms: Date.now() - t1, timedOut };
		const why = timedOut ? ` (killed after VERIFY_CLEARCASE_TIMEOUT_MS=${limit}; later steps did not run)` : '';
		for (const r of inner?.results ?? []) steps.push({ ...r, id: r.id, title: r.title });
		const innerOk = exit.code === 0 && inner?.ok === true;
		if (!inner) steps.push({ id: 'offline', status: 'FAIL', error: `the offline namespace exited ${JSON.stringify(exit)}${why} without inner.json; see offline.log` });
		else if (!innerOk) steps.push({ id: 'offline', status: 'FAIL', error: `offline namespace exited ${JSON.stringify(exit)}${why}, inner ok=${inner.ok}; see offline.log and inner.json` });
		if (!innerOk) code = 1;
	} catch (e) {
		code = 1;
		if (!e.quiet) steps.push({ id: 'runner', status: 'FAIL', error: String(e?.stack ?? e).slice(0, 4000) });
	}
	// 3. cleanup: only this run's PIDs and scratch; the evidence stays
	const c = o['keep-scratch'] ? { kept: scratch } : cleanupRun(scratch);
	summary.cleanup = c;
	const cleaned = o['keep-scratch'] ? true : c.removed && !c.survivors.length;
	steps.push({ id: 'cleanup', title: 'kill only recorded PIDs still running from this run\'s scratch; remove scratch', status: cleaned ? 'PASS' : 'FAIL', evidence: c });
	if (!cleaned) code = 1;
	// 4. the evidence survived the cleanup
	const screens = existsSync(join(evidence, 'screens')) ? readdirSync(join(evidence, 'screens')) : [];
	// Each file is required once the step that writes it has run, so a failed run is checked for what it did produce.
	const ran = (id) => steps.some((s) => s.id === id && s.status !== 'NOT RUN');
	const want = [['clearcase-build.json', ran('isolated-build') && steps.find((s) => s.id === 'isolated-build').status === 'PASS'],
		['offline.log', !!summary.offline], ['inner.json', ran('net-offline')], ['server.log', ran('boot')], ['health.json', ran('live-doctor')]].filter(([, w]) => w).map(([f]) => f);
	const kept = want.filter((f) => existsSync(join(evidence, f)));
	const shots = steps.filter((s) => s.status === 'PASS' && typeof s.evidence?.shot === 'string').map((s) => s.evidence.shot.split('/').pop());
	const lost = [...want.filter((f) => !kept.includes(f)), ...shots.filter((f) => !screens.includes(f)).map((f) => `screens/${f}`)];
	const survived = existsSync(evidence) && !lost.length && (code !== 0 || (want.length === 5 && screens.length >= 9));
	steps.push({ id: 'evidence-kept', title: 'evidence exists after cleanup', status: survived ? 'PASS' : 'FAIL', evidence: { dir: evidence, files: kept, screens, lost }, error: lost.length ? `missing after cleanup: ${lost.join(', ')}` : undefined });
	if (!survived) code = 1;
	return finish(code);
}

async function cmdLiveDoctor(o) {
	if (!o.url || !o.pid || !o['data-dir'] || !o['build-stamp']) { console.error('usage: verify-clearcase live-doctor --url URL --pid PID --data-dir DIR --build-stamp FILE [--originals-port N] [--bun VERSION] [--start-script FILE]'); return 2; }
	const appPort = Number(new URL(o.url).port), originalsPort = Number(o['originals-port'] ?? appPort + 1);
	const pin = /^bun@(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).packageManager ?? '')?.[1];
	const r = await liveDoctor({ url: o.url, expect: { pid: Number(o.pid), dataDir: o['data-dir'], appPort, originalsPort, originalsOrigin: `http://clearcase-originals.localhost:${originalsPort}`, build: JSON.parse(readFileSync(o['build-stamp'], 'utf8')), bun: o.bun ?? pin, startScript: o['start-script'] } });
	console.log(`${formatDoctor(r)}\nlive-doctor: ${r.pass ? 'PASS' : 'FAIL'}`);
	return r.pass ? 0 : 1;
}

function cmdCleanup(o) {
	const root = scratchRoot();
	const ids = o['run-id'] ? [o['run-id']] : existsSync(root) ? readdirSync(root) : [];
	let bad = 0;
	for (const id of ids) {
		const r = cleanupRun(join(root, id));
		if (r.survivors.length || !r.removed) bad++;
		console.log(`${r.removed ? 'removed ' : 'KEPT    '} ${r.scratch}: killed ${r.killed.length}, survivors ${r.survivors.map((s) => s.pid).join(' ') || 'none'}`);
	}
	console.log(`cleanup: ${ids.length} run(s) under ${root}; evidence under ${reportRoot()} untouched.`);
	return bad ? 1 : 0;
}

const [cmd = 'run', ...rest] = process.argv.slice(2);
const o = flags(rest);
const commands = {
	run: () => run(o),
	preflight: () => { const r = preflight({ rev: o.rev ?? 'HEAD' }); console.log(JSON.stringify(r.facts, null, 1)); if (!r.ok) console.error(`verify-clearcase: SKIPPED preflight:\n  - ${r.problems.join('\n  - ')}`); else console.log('preflight: PASS'); return r.ok ? 0 : 3; },
	'live-doctor': () => cmdLiveDoctor(o),
	cleanup: () => cmdCleanup(o),
	features: async () => { const ix = await featureIndex(pilotSteps); console.log(formatIndex(ix)); return ix.ok ? 0 : 1; },
	'self-test': async () => (await import('./self-test.mjs')).selfTest(o, { SKILL, REPO, CHROME, ports, reportRoot, scratchRoot }),
};
if (cmd === '--help' || cmd === 'help' || !commands[cmd]) {
	console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
	process.exit(commands[cmd] || cmd === '--help' || cmd === 'help' ? 0 : 2);
}
process.exit(await commands[cmd]());
