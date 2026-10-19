// The hosted lifecycle INSIDE the offline network namespace (tests/e2e/pilot/offline.sh), started by main.mjs:
//   bun inner.mjs CONFIG.json
// Proves the namespace is offline, builds the hosted-gate artifact of HEAD with `build:hosted`, runs the caller's
// build checks, serves it with `start:hosted` (Node hosts Wrangler, native workerd serves, local D1 and R2), runs the
// live doctor and its negative controls, the caller's server checks, the Chromium drive (drive.mjs, through
// $CLEARCASE_BROWSER_LOCK when set), and stops the server with `start:hosted --stop`. Results: <evidence>/inner.json,
// rewritten after every step (partial: true until the end).
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDoctor, liveDoctor, tree } from './doctor.mjs';
import { buildProblem, PROFILE, testSummaryProblem } from './evidence.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { proveOffline } = await import(join(cfg.harness, 'netproof.mjs'));
const { gateFixture } = await import(cfg.fixtureModule);
const ev = cfg.evidence, repo = cfg.repo, app = `http://127.0.0.1:${cfg.ports.app}`;
const bun = (...args) => [process.execPath, 'run', '--bun', ...args];
const stateFile = join(repo, '.local', 'hosted', `server-${cfg.ports.app}.json`);
const pid = (role, p) => appendFileSync(cfg.pidFile, JSON.stringify({ role, pid: p, at: new Date().toISOString() }) + '\n');
pid('inner', process.pid);

const results = [];
let failed = false, stamp = null, state = null, server = null, serverTree = [];
const save = (ok = null) => writeFileSync(join(ev, 'inner.json'), JSON.stringify({ ok, partial: ok === null, revision: cfg.revision, ports: cfg.ports, stamp, state, results }, null, 1));
const step = async (id, title, fn) => {
	if (failed) { results.push({ id, title, status: 'NOT RUN' }); save(); return null; }
	const t0 = Date.now();
	try {
		const evidence = await fn();
		results.push({ id, title, status: 'PASS', ms: Date.now() - t0, evidence });
		console.log(`PASS    ${id} ${title}`);
		save();
		return evidence;
	} catch (e) {
		failed = true;
		results.push({ id, title, status: 'FAIL', ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 4000) });
		console.log(`FAIL    ${id} ${title}\n        ${String(e?.message ?? e).slice(0, 600)}`);
		save();
		return null;
	}
};

/** SIGTERM to `root` and every descendant, then SIGKILL to what is left after 5 s. */
async function killTree(root) {
	const procs = tree(root);
	for (const sig of ['SIGTERM', 'SIGKILL']) {
		for (const p of procs) try { process.kill(p.pid, sig); } catch {}
		for (const until = Date.now() + 5000; Date.now() < until && procs.some((p) => existsSync(`/proc/${p.pid}`)); ) await new Promise((r) => setTimeout(r, 100));
	}
}

/** Runs `cmd` to completion with its output in `log`; rejects on a non-zero exit or after `ms`. */
function run(cmd, { log, env = {}, cwd = repo, ms = 600_000 }) {
	return new Promise((resolve, reject) => {
		const out = createWriteStream(join(ev, log));
		const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.pipe(out, { end: false });
		child.stderr.pipe(out, { end: false });
		const timer = ms && setTimeout(() => { out.write(`\ninner: no exit within ${ms} ms; stopping the process tree\n`); void killTree(child.pid); }, ms);
		child.on('error', (e) => { clearTimeout(timer); reject(e); });
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			out.end();
			if (code === 0) resolve({ code });
			else reject(new Error(`${cmd.slice(1).join(' ')} exited ${code ?? signal}; see ${log}: ${readFileSync(join(ev, log), 'utf8').trim().split('\n').slice(-6).join(' | ').slice(0, 900)}`));
		});
	});
}
const portOpen = (port) => new Promise((resolve) => {
	const s = connect({ host: '127.0.0.1', port });
	s.once('connect', () => { s.destroy(); resolve(true); });
	s.once('error', () => resolve(false));
});
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The caller's checks for one phase (`build` or `server`): each a command with its log, and optionally a summary it must write. */
async function checks(at) {
	for (const c of cfg.checks.filter((c) => c.at === at)) {
		await step(c.id, c.title, async () => {
			const summary = c.summary && join(repo, c.summary);
			if (summary) rmSync(summary, { force: true });
			await run(c.cmd, { log: `${c.id.replace(/[^\w.-]/g, '-')}.log`, cwd: c.cwd ? join(repo, c.cwd) : repo, env: c.env ?? {} });
			if (!summary) return { log: `${c.id.replace(/[^\w.-]/g, '-')}.log` };
			if (!existsSync(summary)) throw new Error(`${c.id} exited 0 but wrote no summary at ${c.summary}`);
			const doc = readJson(summary);
			const bad = testSummaryProblem(doc, cfg.revision);
			if (bad) throw new Error(bad);
			cpSync(summary, join(ev, 'test-hosted.json'));
			return { summary: 'test-hosted.json', legs: doc.legs.map((l) => `${l.name} ${l.status} ${l.asserted.length}`) };
		});
	}
}

async function stopServer() {
	if (!server) return { started: false };
	const out = { command: 'start:hosted --stop' };
	try { await run(bun('start:hosted', '--stop'), { log: 'stop.log', env: { PORT: String(cfg.ports.app) }, ms: 60_000 }); out.stop = 'exit 0'; } catch (e) { out.stop = String(e.message); }
	for (const until = Date.now() + 20_000; Date.now() < until && server.exitCode === null && server.signalCode === null; ) await new Promise((r) => setTimeout(r, 100));
	out.starterExit = server.exitCode ?? server.signalCode;
	out.survivors = serverTree.filter((p) => existsSync(`/proc/${p.pid}`)).map((p) => `${p.pid} ${p.exe}`);
	out.portOpen = await portOpen(cfg.ports.app);
	out.stateFile = existsSync(stateFile);
	if (state?.runDir) {
		const runDir = join(repo, state.runDir);
		if (existsSync(join(runDir, 'logs'))) cpSync(join(runDir, 'logs'), join(ev, 'wrangler'), { recursive: true });
		if (!out.survivors.length) rmSync(runDir, { recursive: true, force: true });
		out.runDirRemoved = !existsSync(runDir);
	}
	server = null;
	return out;
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
	failed = true;
	results.push({ id: 'stop', title: `stopped by ${sig}`, status: 'FAIL', evidence: await stopServer() });
	save(false);
	process.exit(1);
});

await step('net-offline', 'only lo exists; outbound TCP and DNS fail; loopback accepts', async () => {
	const r = await proveOffline();
	if (!r.pass) throw new Error(`not offline: ${JSON.stringify(r)}`);
	return r;
});

await step('build', `bun run --bun build:hosted (${PROFILE}) inside the namespace: the artifact is stamped with HEAD ${cfg.revision.slice(0, 12)}`, async () => {
	await run(bun('build:hosted'), { log: 'build.log', env: { CLEARCASE_HOSTED_PROFILE: PROFILE }, ms: 300_000 });
	const sidecar = readJson(join(repo, '.svelte-kit', 'clearcase-hosted.json'));
	const bad = buildProblem(sidecar, readJson(join(repo, '.svelte-kit', 'cloudflare', '_app', 'version.json')), cfg.revision);
	if (bad) throw new Error(bad);
	stamp = sidecar.stamp;
	writeFileSync(join(ev, 'clearcase-hosted.json'), JSON.stringify(sidecar, null, 1) + '\n');
	return { stamp, artifact: sidecar.artifact };
});

await checks('build');

await step('start', `bun run --bun start:hosted on ${app}: provision local D1 and R2, wrangler dev --local on Node, workerd serves`, async () => {
	if (existsSync(stateFile)) throw new Error(`${stateFile} exists: a hosted server of this worktree already uses port ${cfg.ports.app}; stop it with PORT=${cfg.ports.app} bun run --bun start:hosted --stop`);
	const out = createWriteStream(join(ev, 'server.log'));
	server = spawn(bun('start:hosted')[0], bun('start:hosted').slice(1), { cwd: repo, env: { ...process.env, PORT: String(cfg.ports.app) }, stdio: ['ignore', 'pipe', 'pipe'] });
	pid('start-hosted', server.pid);
	server.stdout.pipe(out);
	server.stderr.pipe(out);
	const t0 = Date.now();
	for (;;) {
		if (existsSync(stateFile)) {
			try { state = readJson(stateFile); } catch { state = null; }
			if (state) break;
		}
		if (server.exitCode !== null || server.signalCode !== null) throw new Error(`start:hosted exited ${server.exitCode ?? server.signalCode} before serving; see server.log`);
		if (Date.now() - t0 > 120_000) throw new Error('start:hosted recorded no server within 120 s; see server.log');
		await new Promise((r) => setTimeout(r, 100));
	}
	if (state.revision !== cfg.revision || state.profile !== PROFILE || state.port !== cfg.ports.app) throw new Error(`the recorded server is ${JSON.stringify(state)}`);
	serverTree = tree(state.pid);
	return { readyMs: Date.now() - t0, state, processes: serverTree.map((p) => `${p.pid} ${p.exe}`) };
});

const expected = () => ({ revision: cfg.revision, buildId: stamp.buildId, profile: PROFILE, runId: state.runId, fixtureSha256: gateFixture().sha256, pid: state.pid, persist: join(repo, state.persist) });

await step('live-doctor', 'the server on the port is this run\'s: start:hosted\'s process tree with workerd, this artifact\'s stamp, this run\'s fixture, live D1 and R2', async () => {
	const r = await liveDoctor({ url: app, expect: expected() });
	writeFileSync(join(ev, 'health.json'), JSON.stringify(r.health, null, 1) + '\n');
	console.log(formatDoctor(r));
	if (!r.pass) throw new Error(`live doctor failed: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} (got ${JSON.stringify(c.got)})`).join(', ')}`);
	return { checks: r.checks.map((c) => c.name), health: 'health.json' };
});

await step('live-doctor-negative', 'the same doctor FAILS against the same server when it expects another revision, build, run, fixture, process or persist directory', async () => {
	const e = expected();
	const other = (s) => s.slice(0, -1) + (s.at(-1) === '0' ? '1' : '0');
	const controls = {
		'other revision': { ...e, revision: other(e.revision) },
		'other build': { ...e, buildId: `${e.buildId}-other` },
		'other run': { ...e, runId: `${e.runId}-other` },
		'other fixture': { ...e, fixtureSha256: other(e.fixtureSha256) },
		'other process': { ...e, pid: process.pid },
		'other persist directory': { ...e, persist: `${e.persist}-other` },
	};
	const out = {};
	for (const [name, exp] of Object.entries(controls)) {
		const r = await liveDoctor({ url: app, expect: exp });
		out[name] = r.checks.filter((c) => !c.pass).map((c) => c.name);
		if (r.pass) throw new Error(`the live doctor passed for "${name}"`);
	}
	return out;
});

await checks('server');

await step('drive', `drive the feature map in Chromium${cfg.lock ? ` (slot through ${cfg.lock})` : ''}`, async () => {
	rmSync(join(ev, 'drive.json'), { force: true });
	const cmd = [process.execPath, join(import.meta.dirname, 'drive.mjs'), process.argv[2]];
	try {
		await run(cfg.lock ? [cfg.lock, ...cmd] : cmd, { log: 'drive.log', ms: cfg.lock ? 0 : 600_000 });
	} finally {
		const drive = existsSync(join(ev, 'drive.json')) ? readJson(join(ev, 'drive.json')) : null;
		for (const r of drive?.results ?? []) results.push({ ...r, id: r.id, drive: true });
	}
	return { drive: 'drive.json' };
});

const stop = await stopServer();
const stopped = stop.started !== false && /exit 0/.test(stop.stop ?? '') && stop.starterExit !== null && !stop.survivors.length && !stop.portOpen && !stop.stateFile;
results.push({ id: 'stop', title: 'start:hosted --stop: the server, Wrangler and workerd are gone, the port is closed, the run state is removed', status: stopped ? 'PASS' : failed && stop.started === false ? 'NOT RUN' : 'FAIL', evidence: stop });
const ok = !failed && stopped && results.every((r) => r.status === 'PASS');
save(ok);
process.exit(ok ? 0 : 1);
