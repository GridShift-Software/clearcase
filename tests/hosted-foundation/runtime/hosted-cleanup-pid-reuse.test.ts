// A retained scratch (--keep-scratch, or a crash) keeps pids.jsonl, and a later manual cleanup reads it. Linux reuses
// pids, so a saved pid proves ownership only while the live process started when the row says it did (PR #75 review
// round 4, GRS-138). Here the "newer, unrelated server" is a live process under real pid and state files whose saved row
// names its pid with another start time, or with none. Cleanup observes no stop through its result (`stop` is only set
// when it ran `start:hosted --stop`), and the server, its pid file and its state file surviving.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processStart, writePidFile } from '../../../scripts/pidfile.ts';
// @ts-expect-error plain .mjs
import { cleanupRun, REPO } from '../../../.agents/skills/verify-clearcase-hosted/lib/main.mjs';

const PORT = 44900 + (process.pid % 90);
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
const other = (start: string | null) => String(Number(start) - 1000);

/** A process standing for a hosted server, recorded in the port's pid file and state file as start:hosted would. */
async function server(repo: string) {
	const child = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' });
	cleanups.push(() => {
		try {
			process.kill(child.pid!, 'SIGKILL');
		} catch {}
	});
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
	const dir = path.join(repo, '.local', 'hosted');
	mkdirSync(dir, { recursive: true });
	const pidFile = path.join(dir, `start-${PORT}.pid`), stateFile = path.join(dir, `server-${PORT}.json`);
	writePidFile(pidFile, sleeper);
	writeFileSync(stateFile, JSON.stringify({ schema: 'clearcase.hosted-server/1', pid: sleeper, port: PORT, runId: 'newer-unrelated-run' }));
	cleanups.push(() => (rmSync(pidFile, { force: true }), rmSync(stateFile, { force: true })));
	return { wrapper: child.pid!, pid: sleeper, pidFile, stateFile };
}

/** A scratch whose pids.jsonl holds `rows` as written by the run (`runId` is the scratch's own name); `at` is always set. */
function scratchOf(...rows: ((runId: string) => Record<string, unknown>)[]) {
	const scratch = mkdtempSync(path.join(tmpdir(), 'hosted-scratch-'));
	cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
	const runId = path.basename(scratch);
	writeFileSync(path.join(scratch, 'pids.jsonl'), rows.map((r) => JSON.stringify({ ...r(runId), at: new Date().toISOString() })).join('\n') + '\n');
	return scratch;
}
const survives = (s: { pid: number; pidFile: string; stateFile: string }) => [alive(s.pid), existsSync(s.pidFile), existsSync(s.stateFile)];

describe('a saved pid proves ownership only while the live process started when the row says', () => {
	it('a retained row naming the pid of a newer, unrelated server (same pid, different start, different run) stops nothing and is reported preserved', async () => {
		const newer = await server(REPO);
		const out = cleanupRun(scratchOf((runId) => ({ role: 'hosted-server', pid: newer.pid, start: other(processStart(newer.pid)), runId })), PORT);
		expect(out.stop).toBeUndefined();
		expect(survives(newer)).toEqual([true, true, true]);
		expect(out.preserved.map((p: { pid: number }) => p.pid)).toEqual([newer.pid]);
		expect(out.preserved[0].files).toEqual([newer.pidFile, newer.stateFile]);
		expect(out.killed).toEqual([]);
	}, 60_000);

	it('a retained row of the old shape ({ role, pid, at }, no start) proves nothing: no stop, the server is preserved', async () => {
		const newer = await server(REPO);
		const out = cleanupRun(scratchOf(() => ({ role: 'start-hosted', pid: newer.pid })), PORT);
		expect(out.stop).toBeUndefined();
		expect(survives(newer)).toEqual([true, true, true]);
		expect(out.preserved.map((p: { pid: number }) => p.pid)).toEqual([newer.pid]);
	}, 60_000);

	it('a retained row with a start but another run\'s name proves nothing either', async () => {
		const newer = await server(REPO);
		const out = cleanupRun(scratchOf(() => ({ role: 'start-hosted', pid: newer.pid, start: processStart(newer.pid), runId: 'another-run' })), PORT);
		expect(out.stop).toBeUndefined();
		expect(survives(newer)).toEqual([true, true, true]);
	}, 60_000);

	it('a saved ancestor whose pid now runs a process with another start does not own the server under it', async () => {
		const newer = await server(REPO);
		const out = cleanupRun(scratchOf((runId) => ({ role: 'start-hosted', pid: newer.wrapper, start: other(processStart(newer.wrapper)), runId })), PORT);
		expect(out.stop).toBeUndefined();
		expect(survives(newer)).toEqual([true, true, true]);
		expect(out.preserved.map((p: { pid: number }) => p.pid)).toEqual([newer.pid]);
	}, 60_000);

	it('control: a row whose saved start equals the live process\'s start is stopped, with its state file removed', async () => {
		const own = await server(REPO);
		const out = cleanupRun(scratchOf((runId) => ({ role: 'hosted-server', pid: own.pid, start: processStart(own.pid), runId })), PORT);
		expect(out.stop).toMatch(/^0: /);
		expect(await gone(own.pid)).toBe(true);
		expect(existsSync(own.stateFile)).toBe(false);
		expect(out.preserved).toEqual([]);
	}, 60_000);

	it('control: a saved ancestor whose start equals its live start owns the server under it', async () => {
		const own = await server(REPO);
		const out = cleanupRun(scratchOf((runId) => ({ role: 'start-hosted', pid: own.wrapper, start: processStart(own.wrapper), runId })), PORT);
		expect(out.stop).toMatch(/^0: /);
		expect(await gone(own.pid)).toBe(true);
	}, 60_000);
});
