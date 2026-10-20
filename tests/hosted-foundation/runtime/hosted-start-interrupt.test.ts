// start:hosted must own the detached Wrangler tree from the moment it spawns it (PR #75 review, GRS-112): an interruption
// or a failure during the wait for "Ready on" leaves no process, no pid file and no state file. `serve` runs in a driver
// process over a stand-in for Wrangler that spawns a child and keeps the group alive; the test signals the driver.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const DRIVER = path.resolve(import.meta.dirname, 'hosted-serve-driver.ts');
const BUN = process.versions.bun ? process.execPath : 'bun';
// a stand-in for Wrangler: it records its own pid and its child's, says Ready on request, and then idles
const stub = (ready: boolean) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.DIR + '/tree', process.pid + ' ' + child.pid);
${ready ? "console.log('Ready on http://127.0.0.1:1');" : ''}
setInterval(() => {}, 1 << 30);
`;
const STUB_HELD = stub(false), STUB_READY = stub(true);

const dirs: string[] = [];
const pids: number[] = [];
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

function launch(stub: string, readyMs: number) {
	const dir = mkdtempSync(path.join(tmpdir(), 'hosted-serve-'));
	dirs.push(dir);
	writeFileSync(path.join(dir, 'wrangler-stub.mjs'), stub);
	const driver = spawn(BUN, [DRIVER, dir, String(readyMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
	pids.push(driver.pid!);
	let output = '';
	driver.stdout.on('data', (b) => (output += b));
	driver.stderr.on('data', (b) => (output += b));
	const tree = async () => {
		await wait(() => existsSync(path.join(dir, 'tree')) && readFileSync(path.join(dir, 'tree'), 'utf8').trim().split(' ').length === 2, 20_000, 'the stand-in to start its tree');
		const members = readFileSync(path.join(dir, 'tree'), 'utf8').trim().split(' ').map(Number);
		pids.push(...members);
		return members;
	};
	return { dir, driver, tree, output: () => output, pidFile: path.join(dir, 'start.pid'), stateFile: path.join(dir, 'server.json') };
}

afterEach(() => {
	// never leak the stand-in's group, whatever the test found
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('start:hosted owns the Wrangler tree from spawn onward', () => {
	it('records the starter in the pid file before Ready, so start --stop has a process to signal during the wait', async () => {
		const run = launch(STUB_HELD, 60_000);
		await run.tree();
		expect(readFileSync(run.pidFile, 'utf8').split(' ')[0]).toBe(String(run.driver.pid));
	}, 60_000);

	it.each(['SIGTERM', 'SIGINT'] as const)('%s during the wait for Ready stops the whole tree and leaves no pid file or state', async (signal) => {
		const run = launch(STUB_HELD, 60_000);
		const members = await run.tree();
		run.driver.kill(signal);
		await exited(run.driver);
		await wait(() => members.every((p) => !running(p)), 10_000, 'the Wrangler tree to exit').catch(() => undefined);
		expect(members.filter(running), run.output()).toEqual([]);
		expect([existsSync(run.pidFile), existsSync(run.stateFile)]).toEqual([false, false]);
	}, 60_000);

	it('a Ready that never comes stops the whole tree, leaves no state and exits nonzero', async () => {
		const run = launch(STUB_HELD, 1500);
		const members = await run.tree();
		expect(await exited(run.driver)).not.toBe(0);
		expect(members.filter(running), run.output()).toEqual([]);
		expect([existsSync(run.pidFile), existsSync(run.stateFile)]).toEqual([false, false]);
		expect(run.output()).toContain('no "Ready on" from Wrangler within 60 s');
	}, 60_000);

	it('a served Wrangler is recorded, and SIGTERM then stops the tree and removes the record', async () => {
		const run = launch(STUB_READY, 60_000);
		const members = await run.tree();
		await wait(() => existsSync(run.stateFile), 20_000, 'the server record');
		expect(readFileSync(run.pidFile, 'utf8').split(' ')[0]).toBe(String(run.driver.pid));
		expect(JSON.parse(readFileSync(run.stateFile, 'utf8')).pid).toBe(run.driver.pid);
		run.driver.kill('SIGTERM');
		expect(await exited(run.driver)).toBe(0);
		expect(members.filter(running), run.output()).toEqual([]);
		expect([existsSync(run.pidFile), existsSync(run.stateFile)]).toEqual([false, false]);
	}, 60_000);
});
