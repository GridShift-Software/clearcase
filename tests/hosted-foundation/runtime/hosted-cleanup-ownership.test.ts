// The hosted verification stops only the server it started (PR #75 review, GRS-138). A run that refuses to start because a
// server already holds its port ran no server of its own, so its cleanup must leave that server, its pid file and its
// state file alone. The "server" here is a sleeping process under real pid and state files for a port of its own.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processStart, writePidFile } from '../../../scripts/pidfile.ts';
// @ts-expect-error plain .mjs
import { cleanupRun, hostedRun, REPO } from '../../../.agents/skills/verify-clearcase-hosted/lib/main.mjs';

const PORT = 44000 + (process.pid % 900);
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});
const alive = (pid: number) => {
	try {
		return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
	} catch {
		return false;
	}
};
const gone = async (pid: number) => {
	for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
	return !alive(pid);
};

/** A process that stands for a hosted server: recorded in the port's pid file and state file as start:hosted would. */
async function server(repo: string) {
	const child = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' });
	cleanups.push(() => {
		try {
			process.kill(child.pid!, 'SIGKILL');
		} catch {}
	});
	// the files name the shell's child; the shell stands for the `bun run` wrapper that start:hosted runs under
	let sleeper = 0;
	for (let i = 0; i < 100 && !sleeper; i++) {
		await new Promise((r) => setTimeout(r, 20));
		try {
			sleeper = Number(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(' ')[0]);
		} catch {}
	}
	cleanups.push(() => {
		try {
			process.kill(sleeper, 'SIGKILL');
		} catch {}
	});
	const pid = sleeper;
	const dir = path.join(repo, '.local', 'hosted');
	mkdirSync(dir, { recursive: true });
	const pidFile = path.join(dir, `start-${PORT}.pid`), stateFile = path.join(dir, `server-${PORT}.json`);
	writePidFile(pidFile, pid);
	writeFileSync(stateFile, JSON.stringify({ schema: 'clearcase.hosted-server/1', pid, port: PORT, runId: 'unowned' }));
	cleanups.push(() => (rmSync(pidFile, { force: true }), rmSync(stateFile, { force: true })));
	return { wrapper: child.pid!, pid, pidFile, stateFile };
}

/** A scratch directory whose pids.jsonl records `roles` the way the run's namespace and inner runner do: pid, start time, run. */
function scratchOf(...records: { role: string; pid: number }[]) {
	const scratch = mkdtempSync(path.join(tmpdir(), 'hosted-scratch-'));
	cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
	writeFileSync(path.join(scratch, 'pids.jsonl'), records.map((r) => JSON.stringify({ ...r, start: processStart(r.pid), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), runId: path.basename(scratch), at: new Date().toISOString() })).join('\n') + '\n');
	return scratch;
}

describe('the hosted verification stops only a server it started', () => {
	it('a run that refused to start because a server holds the port leaves that server, its pid file and its state alone', async () => {
		const other = await server(REPO);
		// the refusing run recorded its namespace and inner runner, then threw before spawning start:hosted
		const out = cleanupRun(scratchOf({ role: 'offline-namespace', pid: process.pid }, { role: 'inner', pid: process.pid }), PORT);
		expect(out.stop).toBeUndefined();
		expect([alive(other.pid), existsSync(other.pidFile), existsSync(other.stateFile)]).toEqual([true, true, true]);
		expect(out.survivors).toEqual([]);
		expect(out.removed).toBe(true);
	}, 60_000);

	it('hostedRun, refused by a server already on the port, fails its own run and leaves that server alive', async () => {
		const other = await server(REPO);
		const dir = mkdtempSync(path.join(tmpdir(), 'hosted-run-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		// the namespace tool is a stand-in that refuses at once, as inner.mjs does when server-PORT.json exists
		const unshare = path.join(dir, 'unshare');
		writeFileSync(unshare, '#!/bin/sh\nexit 1\n');
		chmodSync(unshare, 0o755);
		const tools = { unshare, ip: unshare, mount: unshare };
		const run = await hostedRun({ revision: 'r', evidence: path.join(dir, 'evidence'), scratch: path.join(dir, 'scratch'), port: { app: PORT, canary: PORT + 99 }, node: { path: process.execPath, version: '0' }, tools, lock: null, log: () => {} });
		expect(run.ok).toBe(false);
		expect([alive(other.pid), existsSync(other.pidFile), existsSync(other.stateFile)]).toEqual([true, true, true]);
		expect(run.steps.find((s: { id: string }) => s.id === 'cleanup')?.evidence?.stop).toBeUndefined();
	}, 60_000);

	it('stops the server whose pid file names a process the run recorded', async () => {
		const own = await server(REPO);
		const out = cleanupRun(scratchOf({ role: 'start-hosted', pid: own.pid }), PORT);
		expect(out.stop).toMatch(/^0: /);
		expect(await gone(own.pid)).toBe(true);
		expect(existsSync(own.stateFile)).toBe(false);
	}, 60_000);

	it('stops the server whose pid file names a descendant of a process the run recorded (the bun wrapper of start:hosted)', async () => {
		const own = await server(REPO);
		const out = cleanupRun(scratchOf({ role: 'start-hosted', pid: own.wrapper }), PORT);
		expect(out.stop).toMatch(/^0: /);
		expect(await gone(own.pid)).toBe(true);
	}, 60_000);

	it('leaves a server whose state file names another process than its pid file, even when the pid file names a recorded one', async () => {
		const other = await server(REPO);
		writeFileSync(other.stateFile, JSON.stringify({ schema: 'clearcase.hosted-server/1', pid: process.pid, port: PORT, runId: 'elsewhere' }));
		const out = cleanupRun(scratchOf({ role: 'start-hosted', pid: other.pid }), PORT);
		expect(out.stop).toBeUndefined();
		expect(alive(other.pid)).toBe(true);
	}, 60_000);
});
