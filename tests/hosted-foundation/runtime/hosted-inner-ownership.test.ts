// The inner lifecycle of the hosted verification (.agents/skills/verify-clearcase-hosted/lib/inner.mjs) stops only the
// starter it launched (PR #75 review, round 3). It runs for real here, as a process of its own, over a scratch repo whose
// `build:hosted` writes a synthetic stamp and whose `start:hosted` is the real `serve` and the real pid-file stop over a
// stand-in for Wrangler (hosted-inner-driver.ts). Another starter holds the port's pid file while it waits for Ready, before
// it writes server-PORT.json: this run's contender loses the claim, and the stop at the end of the run must leave that
// starter, its pid file and its later state file alone.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs
import { BUN_PIN } from '../../../.agents/skills/verify-clearcase-hosted/lib/evidence.mjs';

const INNER = path.resolve(import.meta.dirname, '../../../.agents/skills/verify-clearcase-hosted/lib/inner.mjs');
const DRIVER = path.resolve(import.meta.dirname, 'hosted-inner-driver.ts');
const FIXTURE = path.resolve(import.meta.dirname, 'gate-fixture.ts');
const BUN = process.versions.bun ? process.execPath : 'bun';
const REV = 'ab'.repeat(20);
// a stand-in for Wrangler: it records its own pid and its child's, and says Ready once DIR/ready exists
const WRANGLER = `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.DIR + '/tree-' + process.pid, process.pid + ' ' + child.pid);
const timer = setInterval(() => { if (existsSync(process.env.DIR + '/ready')) { console.log('Ready on http://127.0.0.1:1'); clearInterval(timer); } }, 50);
setInterval(() => {}, 1 << 30);
`;
const BUILD = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.svelte-kit/cloudflare/_app', { recursive: true });
const stamp = { revision: '${REV}', dirty: false, exported: false, builtAt: new Date().toISOString(), bun: '${BUN_PIN}', buildId: '${REV.slice(0, 12)}-hosted-gate-1', target: 'cloudflare', profile: 'hosted-gate' };
writeFileSync('.svelte-kit/clearcase-hosted.json', JSON.stringify({ schema: 'clearcase.hosted-build/1', stamp, artifact: 'sha256:' + '0'.repeat(64) }));
writeFileSync('.svelte-kit/cloudflare/_app/version.json', JSON.stringify({ version: '${REV}' }));
`;

const cleanups: (() => void)[] = [];
const pids: number[] = [];
afterEach(() => {
	// never leak a stand-in, whatever the test found
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
	for (const c of cleanups.splice(0).reverse()) c();
});
const wait = async (until: () => boolean, ms: number, what: string) => {
	for (const stop = Date.now() + ms; !until(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
};
const running = (pid: number) => {
	try {
		return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
	} catch {
		return false;
	}
};
const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))));
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** A scratch repo, harness and evidence directory for one port; `delayMs` holds this run's `start:hosted` back. */
function scratch(delayMs = 0) {
	const dir = mkdtempSync(path.join(tmpdir(), 'hosted-inner-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const repo = path.join(dir, 'repo'), harness = path.join(dir, 'harness'), evidence = path.join(dir, 'evidence');
	for (const d of [repo, harness, evidence, path.join(repo, '.local', 'hosted')]) mkdirSync(d, { recursive: true });
	const port = 45000 + (process.pid % 900);
	const stub = path.join(dir, 'wrangler-stub.mjs');
	writeFileSync(stub, WRANGLER);
	writeFileSync(path.join(repo, 'build-stub.mjs'), BUILD);
	writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'build:hosted': 'bun build-stub.mjs', 'start:hosted': `${delayMs ? `sleep ${delayMs / 1000}; ` : ''}bun ${DRIVER}` } }));
	writeFileSync(path.join(harness, 'netproof.mjs'), 'export const proveOffline = async () => ({ pass: true });\n');
	const pidsFile = path.join(dir, 'pids.jsonl');
	writeFileSync(pidsFile, '');
	const config = path.join(dir, 'config.json');
	writeFileSync(config, JSON.stringify({ repo, revision: REV, ports: { app: port }, evidence, harness, fixtureModule: FIXTURE, profileDir: path.join(dir, 'profile'), pidFile: pidsFile, app: `http://127.0.0.1:${port}`, lock: null, checks: [] }));
	const hosted = path.join(repo, '.local', 'hosted');
	const env = { ...process.env, PORT: String(port), REV, STUB: stub };
	return { dir, repo, evidence, port, config, env, pidsFile, pidFile: path.join(hosted, `start-${port}.pid`), stateFile: path.join(hosted, `server-${port}.json`), ready: path.join(hosted, 'ready') };
}
type Scratch = ReturnType<typeof scratch>;

/** Another starter on the port: holds its pid file while it waits for Ready, which comes when DIR/ready exists. */
async function otherStarter(s: Scratch) {
	const child = spawn(BUN, [DRIVER], { cwd: s.repo, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
	pids.push(child.pid!);
	await wait(() => existsSync(s.pidFile) && readFileSync(s.pidFile, 'utf8').startsWith(`${child.pid} `), 20_000, 'the other starter to claim the pid file');
	const tree = path.join(s.repo, '.local', 'hosted');
	await wait(() => readdirTree(tree).length > 0, 20_000, 'the other starter\'s Wrangler');
	pids.push(...readdirTree(tree).flatMap((f) => readFileSync(path.join(tree, f), 'utf8').trim().split(' ').map(Number)));
	return child;
}
const readdirTree = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('tree-')) : []);

/** Runs inner.mjs over the scratch repo to its end; resolves with its exit code and its inner.json. */
async function runInner(s: Scratch) {
	const inner = spawn(BUN, [INNER, s.config], { cwd: s.dir, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
	pids.push(inner.pid!);
	let output = '';
	inner.stdout.on('data', (b) => (output += b));
	inner.stderr.on('data', (b) => (output += b));
	return { inner, output: () => output, code: exited(inner), result: () => json(path.join(s.evidence, 'inner.json')) as { results: { id: string; status: string; error?: string; evidence?: Record<string, unknown> }[] } };
}
const step = (r: { results: { id: string }[] }, id: string) => r.results.find((x) => x.id === id) as { id: string; status: string; error?: string; evidence?: Record<string, unknown> };

describe('inner.mjs stops only the starter this run launched', () => {
	it('a contender that loses the pid-file claim to a starter held before Ready leaves that starter, its pid file and its later state file alone', async () => {
		const s = scratch();
		const other = await otherStarter(s);
		const run = await runInner(s);
		expect(await run.code, run.output()).not.toBe(0);
		const result = run.result();
		expect(step(result, 'start').status).toBe('FAIL');
		expect(step(result, 'start').error).toMatch(/exited 2 before serving/);
		expect(step(result, 'stop').status).not.toBe('PASS');
		expect(String(step(result, 'stop').evidence?.stop)).toMatch(/refus/i);
		// the original owner survives the verifier's stop, finishes starting, and its state file appears
		expect([running(other.pid!), readFileSync(s.pidFile, 'utf8').startsWith(`${other.pid} `)], run.output()).toEqual([true, true]);
		writeFileSync(s.ready, '');
		await wait(() => existsSync(s.stateFile), 20_000, 'the original owner to write its state file');
		expect(json(s.stateFile).pid).toBe(other.pid);
		expect(running(other.pid!)).toBe(true);
	}, 90_000);

	it('a state file that appears from another starter while this run waits is not recorded as this run\'s hosted-server, and that starter survives', async () => {
		const s = scratch(4000); // the contender is held back, so the other starter's state file lands while it waits
		const other = await otherStarter(s);
		const run = await runInner(s);
		await wait(() => existsSync(path.join(s.evidence, 'inner.json')) && step(run.result(), 'build')?.status === 'PASS', 30_000, 'the build step');
		writeFileSync(s.ready, '');
		await wait(() => existsSync(s.stateFile), 20_000, 'the other starter to write its state file');
		expect(await run.code, run.output()).not.toBe(0);
		expect(readFileSync(s.pidsFile, 'utf8')).not.toContain(`"role":"hosted-server"`);
		expect(step(run.result(), 'start').status).toBe('FAIL');
		expect([running(other.pid!), existsSync(s.pidFile), json(s.stateFile).pid], run.output()).toEqual([true, true, other.pid]);
	}, 90_000);

	it('a server this run did start is still stopped by it: the starter, its Wrangler tree, the pid file and the state file are gone', async () => {
		const s = scratch();
		writeFileSync(s.ready, '');
		const run = await runInner(s);
		await run.code;
		const result = run.result();
		expect(step(result, 'start').status, run.output()).toBe('PASS');
		const stop = step(result, 'stop');
		expect([stop.status, String(stop.evidence?.stop), stop.evidence?.survivors, stop.evidence?.stateFile], run.output()).toEqual(['PASS', 'exit 0', [], false]);
		expect(existsSync(s.pidFile)).toBe(false);
	}, 90_000);
});
