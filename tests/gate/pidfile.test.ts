import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimPidFile, livePid, orphanedGroup, processStart, readPidFile, removePidFile, stopPidFile, writePidFile } from '../../scripts/pidfile.ts';

let dir: string;
const kids: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pidfile-test-')); });
afterEach(() => {
	for (const k of kids.splice(0)) try { process.kill(k.pid!, 'SIGKILL'); } catch {}
	rmSync(dir, { recursive: true, force: true });
});
const sleeper = (opts = {}) => { const k = spawn('sleep', ['60'], { stdio: 'ignore', ...opts }); kids.push(k); return k; };
const running = (pid: number) => { const s = processStart(pid); return s !== null && !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); };
const exited = (k: ChildProcess) => new Promise((r) => (k.exitCode !== null || k.signalCode !== null ? r(null) : k.once('exit', r)));

describe('pid files', () => {
	it('records the pid with its start time and removes only its own file', () => {
		const f = join(dir, 'a', 'pid');
		writePidFile(f);
		expect(readPidFile(f)).toEqual({ pid: process.pid, start: processStart(process.pid) });
		removePidFile(f, process.pid + 1);
		expect(existsSync(f)).toBe(true);
		removePidFile(f);
		expect(existsSync(f)).toBe(false);
	});

	it('treats a reused pid (another start time) as stale and never signals it', async () => {
		const k = sleeper();
		const f = join(dir, 'pid');
		writeFileSync(f, `${k.pid} 1\n`);
		expect(livePid(f)).toBeNull();
		expect(existsSync(f)).toBe(false);
		writeFileSync(f, `${k.pid} 1\n`);
		expect(await stopPidFile(f)).toMatchObject({ ok: true, message: expect.stringMatching(/^nothing to stop/) });
		expect(running(k.pid!)).toBe(true);
	});

	it('stops the recorded process and leaves a bystander running the same command', async () => {
		const target = sleeper(), bystander = sleeper();
		const f = join(dir, 'pid');
		writePidFile(f, target.pid);
		expect((await stopPidFile(f, { graceMs: 2000 })).message).toMatch(/^stopped process \d+ \(SIGTERM\)$/);
		await exited(target);
		expect(running(bystander.pid!)).toBe(true);
		expect(existsSync(f)).toBe(false);
	});

	it('stops a whole process group, children included, and nothing outside it', async () => {
		const leader = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
		kids.push(leader);
		const grandchild = Number(await new Promise<string>((r) => leader.stdout!.once('data', (d) => r(String(d).trim()))));
		const bystander = sleeper();
		const f = join(dir, 'pid');
		writePidFile(f, leader.pid);
		expect((await stopPidFile(f, { group: true, graceMs: 2000 })).message).toMatch(/^stopped process group/);
		expect(processStart(grandchild)).toBeNull();
		expect(running(bystander.pid!)).toBe(true);
	});

	it('escalates to SIGKILL when SIGTERM is ignored', async () => {
		const k = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 0.1; done'], { stdio: 'ignore' });
		kids.push(k);
		await new Promise((r) => setTimeout(r, 200));
		const f = join(dir, 'pid');
		writePidFile(f, k.pid);
		expect((await stopPidFile(f, { graceMs: 500 })).message).toMatch(/SIGKILL after SIGTERM\)$/);
	});

	// A group whose leader was SIGKILLed: the leader's children keep running in the group (the gate's e2e servers and Chromium).
	const MARK = { name: 'PIDFILE_TEST_LEADER', value: '/repo/a' };
	const orphan = async (env: Record<string, string>) => {
		const leader = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } });
		kids.push(leader);
		const child = Number(await new Promise<string>((r) => leader.stdout!.once('data', (d) => r(String(d).trim()))));
		const f = join(dir, 'pid');
		writePidFile(f, leader.pid);
		process.kill(leader.pid!, 'SIGKILL');
		await exited(leader);
		return { f, child, leader: leader.pid! };
	};

	it('stops the orphaned group of a SIGKILLed leader when a member carries the marker', async () => {
		const { f, child, leader } = await orphan({ [MARK.name]: MARK.value });
		expect(running(child)).toBe(true);
		expect(orphanedGroup(f, MARK)).toBe(leader);
		const r = await stopPidFile(f, { group: true, graceMs: 2000, marker: MARK });
		expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/^stopped process group \d+ \(SIGTERM, its leader had already died\)$/) });
		expect(processStart(child)).toBeNull();
		expect(existsSync(f)).toBe(false);
	});

	it('leaves an orphaned group alone when no member carries this repo\'s marker', async () => {
		for (const env of [{}, { [MARK.name]: '/repo/other' }]) {
			const { f, child } = await orphan(env);
			expect(orphanedGroup(f, MARK)).toBeNull();
			expect(await stopPidFile(f, { group: true, graceMs: 500, marker: MARK })).toMatchObject({ ok: true, message: expect.stringMatching(/^nothing to stop/) });
			expect(running(child)).toBe(true);
			expect(existsSync(f)).toBe(false);
		}
	});

	it('does not touch an orphaned group without a marker option', async () => {
		const { f, child } = await orphan({ [MARK.name]: MARK.value });
		expect((await stopPidFile(f, { group: true, graceMs: 500 })).message).toMatch(/^nothing to stop/);
		expect(running(child)).toBe(true);
	});

	it('reports a failed stop: ok is false and the file stays when the process is still running', async () => {
		const k = sleeper();
		const f = join(dir, 'pid');
		writePidFile(f, k.pid);
		const r = await stopPidFile(f, { graceMs: 200, killMs: 200, send: () => {} });
		expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/but it is still running$/) });
		expect(existsSync(f)).toBe(true);
		expect(running(k.pid!)).toBe(true);
	});

	describe('claimPidFile', () => {
		it('claims a free file with a whole record, refuses a live owner, and leaves no temporary files', () => {
			const f = join(dir, 'a', 'pid');
			const a = sleeper();
			expect(claimPidFile(f, process.pid)).toEqual({ claimed: true });
			expect(readPidFile(f)).toEqual({ pid: process.pid, start: processStart(process.pid) });
			expect(claimPidFile(f, a.pid)).toEqual({ claimed: false, owner: { pid: process.pid, start: processStart(process.pid) } });
			expect(readPidFile(f)?.pid).toBe(process.pid);
			expect(readdirSync(join(dir, 'a'))).toEqual(['pid']);
		});

		it('takes over a record of a dead process and of a reused pid', () => {
			const f = join(dir, 'pid');
			const k = sleeper();
			for (const rec of ['2147483000 1', `${k.pid} 1`]) {
				writeFileSync(f, `${rec}\n`);
				expect(claimPidFile(f)).toEqual({ claimed: true });
				expect(readPidFile(f)?.pid).toBe(process.pid);
				rmSync(f);
			}
			expect(running(k.pid!)).toBe(true);
		});

		it('takes over a malformed record', () => {
			const f = join(dir, 'pid');
			writeFileSync(f, '');
			expect(claimPidFile(f)).toEqual({ claimed: true });
		});

		it('clears a recovery guard left by a crashed process, but waits for a fresh one', () => {
			const f = join(dir, 'pid');
			writeFileSync(f, '2147483000 1\n');
			mkdirSync(`${f}.recover`);
			const old = new Date(Date.now() - 60_000);
			utimesSync(`${f}.recover`, old, old);
			expect(claimPidFile(f)).toEqual({ claimed: true });
			expect(existsSync(`${f}.recover`)).toBe(false);
			rmSync(f);
			writeFileSync(f, '2147483000 1\n');
			mkdirSync(`${f}.recover`);
			expect(claimPidFile(f)).toEqual({ claimed: false, owner: null });
			expect(readPidFile(f)?.pid).toBe(2147483000);
		});
	});
});
