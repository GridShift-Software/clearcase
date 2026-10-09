// verify-clearcase self-test: the two failure modes the runner must catch, without building anything.
//  1. clean checkout: the runner in a `git archive` copy without node_modules stops at preflight (exit 3) with the
//     install command, and never builds, never launches Chromium and never runs `bun install` (shims record every
//     bun and Chromium invocation; the only bun run allowed is the runner itself), and opens no connection: the
//     package registry and every proxy variable point at a local listener that must see nothing.
//  2. missing tool: the same with CLEARCASE_CHROMIUM naming nothing, in this checkout (whose node_modules exist).
//  3. stale or wrong-build instance: the live doctor against a server on the app port that answers /api/health for
//     another process, data directory, build, Bun or storage state, or nothing at all, FAILS; the matching answer PASSES.
// Results: <report>/selftest-<id>/self-test.json. Exit 0 only when every case holds.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveDoctor } from './live-doctor.mjs';

export async function selfTest(_o, ctx) {
	const { SKILL, REPO, CHROME, ports, reportRoot, scratchRoot } = ctx;
	const id = `selftest-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
	const out = join(reportRoot(), id), scratch = join(scratchRoot(), id);
	mkdirSync(out, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	const cases = [];
	const record = (name, pass, evidence) => { cases.push({ name, pass, evidence }); console.log(`${pass ? 'PASS' : 'FAIL'}     ${name}`); if (!pass) console.log(`         ${JSON.stringify(evidence).slice(0, 1500)}`); };
	try {
		// shims that log every invocation, then run the real program
		const shims = join(scratch, 'shims'), calls = join(scratch, 'calls.log');
		mkdirSync(shims);
		const shim = (name, real) => { const f = join(shims, name); writeFileSync(f, `#!/bin/bash\nprintf '%s %s\\n' ${name} "$*" >>'${calls}'\nexec '${real}' "$@"\n`); chmodSync(f, 0o755); return f; };
		const bunShim = shim('bun', process.execPath), chromeShim = shim('chrome', CHROME);
		// a network canary: the package registry and every proxy point at a local listener that counts connections
		const hits = [];
		const net = Bun.listen({ hostname: '127.0.0.1', port: ports().selfTest + 1, socket: { open(sock) { hits.push(Date.now()); sock.end(); }, data() {} } });
		const canary = `http://127.0.0.1:${ports().selfTest + 1}`;
		const offlineEnv = { BUN_CONFIG_REGISTRY: canary, NPM_CONFIG_REGISTRY: canary, npm_config_registry: canary, HTTP_PROXY: canary, HTTPS_PROXY: canary, ALL_PROXY: canary, http_proxy: canary, https_proxy: canary, all_proxy: canary, NO_PROXY: '', no_proxy: '' };
		const runner = (root, extra = {}) => {
			writeFileSync(calls, '');
			const report = join(scratch, `report-${cases.length}`);
			const r = spawnSync(join(root, '.agents/skills/verify-clearcase/bin/verify-clearcase'), ['run'], { encoding: 'utf8', cwd: root, timeout: 60000,
				env: { PATH: process.env.PATH, HOME: process.env.HOME, ...offlineEnv, CLEARCASE_BUN: bunShim, CLEARCASE_CHROMIUM: chromeShim, CLEARCASE_REPORT_DIR: report, VERIFY_CLEARCASE_SCRATCH: join(scratch, `runs-${cases.length}`), ...extra } });
			const runs = existsSync(join(report, 'skill')) ? readdirSync(join(report, 'skill')) : [];
			const summary = runs.length === 1 ? JSON.parse(readFileSync(join(report, 'skill', runs[0], 'summary.json'), 'utf8')) : null;
			const invoked = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
			const scratchLeft = existsSync(join(scratch, `runs-${cases.length}`)) ? readdirSync(join(scratch, `runs-${cases.length}`)) : [];
			return { code: r.status, stderr: r.stderr, invoked, summary, scratchLeft, networkHits: hits.splice(0).length };
		};
		const quiet = (r) => r.networkHits === 0;
		const onlyRunner = (inv) => inv.length === 1 && /^bun \S+\/lib\/main\.mjs run$/.test(inv[0]);
		const notBuilt = (s) => s?.result === 'SKIPPED' && s.steps.filter((x) => x.id !== 'preflight').every((x) => x.status === 'NOT RUN');

		// 1. a clean checkout: git archive of HEAD plus this skill (untracked until committed), committed in a scratch repo
		const clean = join(scratch, 'clean');
		mkdirSync(clean);
		const ok = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr}`); };
		ok(spawnSync('bash', ['-c', 'git -C "$0" archive --format=tar HEAD | tar -x -C "$1"', REPO, clean], { encoding: 'utf8' }), 'git archive');
		rmSync(join(clean, '.agents/skills/verify-clearcase'), { recursive: true, force: true });
		cpSync(SKILL, join(clean, '.agents/skills/verify-clearcase'), { recursive: true });
		ok(spawnSync('bash', ['-c', 'cd "$0" && git init -q -b dev && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm clean', clean], { encoding: 'utf8' }), 'git init');
		const a = runner(clean);
		record('clean checkout: preflight stops with the install command (exit 3), no build, no browser, no bun install',
			a.code === 3 && /node_modules/.test(a.stderr) && a.stderr.includes('bun install --frozen-lockfile') && onlyRunner(a.invoked) && quiet(a) && notBuilt(a.summary) && !existsSync(join(clean, 'node_modules')) && !a.scratchLeft.length,
			{ code: a.code, stderr: a.stderr.slice(-800), invoked: a.invoked, networkHits: a.networkHits, steps: a.summary?.steps, scratchLeft: a.scratchLeft });

		// 2. a missing tool, in this checkout
		const b = runner(REPO, { CLEARCASE_CHROMIUM: join(scratch, 'no-such-chromium') });
		record('missing Chromium: preflight names it and the fix (exit 3), no build, no browser',
			b.code === 3 && b.stderr.includes('Chromium not found at') && b.stderr.includes('CLEARCASE_CHROMIUM') && onlyRunner(b.invoked) && quiet(b) && notBuilt(b.summary),
			{ code: b.code, stderr: b.stderr.slice(-800), invoked: b.invoked, networkHits: b.networkHits });
		net.stop(true);

		// 3. the live doctor against stale or wrong-build instances
		const port = ports().selfTest;
		const dataDir = join(scratch, 'data'), otherDir = join(scratch, 'other-data');
		mkdirSync(dataDir); mkdirSync(otherDir);
		const stamp = { revision: 'a'.repeat(40), dirty: false, exported: true, builtAt: '2026-10-09T00:00:00.000Z', bun: '1.4.2', pdfjs: '6.4.299', buildId: '0123456789abcdef' };
		const expect = { pid: 424242, dataDir, appPort: port, originalsPort: port + 1, originalsOrigin: `http://clearcase-originals.localhost:${port + 1}`, build: stamp, bun: '1.4.2' };
		const healthy = () => ({ instance: { id: 'x', pid: expect.pid, startedAt: 'now', bun: '1.4.2', dataDir, appPort: port, originalsPort: port + 1, originalsOrigin: expect.originalsOrigin, build: { ...stamp } },
			pragmas: { main: { journal_mode: 'wal', synchronous: 2 }, work: { journal_mode: 'delete', synchronous: 2 }, foreign_keys: 1 }, storageError: null, recovery: null, warnings: [] });
		let answer = healthy();
		const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json(answer) });
		try {
			const variants = {
				'matching instance': [(h) => h, true],
				'stale process (another pid)': [(h) => { h.instance.pid = process.pid; return h; }, false, 'pid'],
				'another data directory': [(h) => { h.instance.dataDir = otherDir; return h; }, false, 'dataDir'],
				'another build (buildId)': [(h) => { h.instance.build.buildId = 'fedcba9876543210'; return h; }, false, 'build.buildId'],
				'another build (revision)': [(h) => { h.instance.build.revision = 'b'.repeat(40); return h; }, false, 'build.revision'],
				'a rebuild of the same revision (builtAt)': [(h) => { h.instance.build.builtAt = '2026-10-10T00:00:00.000Z'; return h; }, false, 'build.builtAt'],
				'a development server (no build stamp)': [(h) => { h.instance.build = null; return h; }, false, 'build.stamp'],
				'another Bun': [(h) => { h.instance.bun = '1.4.1'; return h; }, false, 'bun'],
				'other ports': [(h) => { h.instance.originalsPort = port + 2; return h; }, false, 'originalsPort'],
				'rollback journal on results.sqlite': [(h) => { h.pragmas.main.journal_mode = 'delete'; return h; }, false, 'pragmas.main.journal_mode'],
				'synchronous NORMAL': [(h) => { h.pragmas.work.synchronous = 1; return h; }, false, 'pragmas.work.synchronous'],
				'storage unavailable': [(h) => { h.storageError = 'synthetic: results.sqlite was removed'; return h; }, false, 'storageError'],
				'no pragmas (storage never opened)': [(h) => { h.pragmas = null; return h; }, false, 'pragmas.main.journal_mode'],
			};
			for (const [name, [mutate, want, field]] of Object.entries(variants)) {
				answer = mutate(healthy());
				const r = await liveDoctor({ url: `http://127.0.0.1:${port}`, expect });
				const failedNames = r.checks.filter((c) => !c.pass).map((c) => c.name);
				record(`live doctor, ${name}: ${want ? 'PASS' : `FAIL on ${field}`}`, r.pass === want && (want || failedNames.includes(field)), { pass: r.pass, failed: failedNames });
			}
			// a real process at the expected pid that is not this run's start.ts
			answer = healthy();
			const r = await liveDoctor({ url: `http://127.0.0.1:${port}`, expect: { ...expect, pid: process.pid, startScript: join(scratch, 'src/scripts/pilot/start.ts') } });
			answer.instance.pid = process.pid;
			const r2 = await liveDoctor({ url: `http://127.0.0.1:${port}`, expect: { ...expect, pid: process.pid, startScript: join(scratch, 'src/scripts/pilot/start.ts') } });
			record('live doctor, the pid runs something other than this run\'s start.ts: FAIL on process', !r2.pass && r2.checks.some((c) => c.name === 'process' && !c.pass) && !r.pass, { failed: r2.checks.filter((c) => !c.pass).map((c) => c.name) });
		} finally { server.stop(true); }
		const gone = await liveDoctor({ url: `http://127.0.0.1:${port}`, expect, timeoutMs: 1500 });
		record('live doctor, nothing listening: FAIL on reachable', !gone.pass && gone.checks[0]?.name === 'reachable', { checks: gone.checks });
	} catch (e) {
		record('self-test harness', false, { error: String(e?.stack ?? e) });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	const okAll = cases.length > 0 && cases.every((c) => c.pass);
	writeFileSync(join(out, 'self-test.json'), JSON.stringify({ ok: okAll, cases }, null, 1) + '\n');
	console.log(`self-test: ${okAll ? 'PASS' : 'FAIL'}. ${cases.filter((c) => c.pass).length}/${cases.length} cases. Evidence: ${join(out, 'self-test.json')}`);
	return okAll ? 0 : 1;
}
