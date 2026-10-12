import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { livePid, processStart, readPidFile, removePidFile, stopPidFile, writePidFile } from '../../scripts/pidfile.ts';

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
		expect(await stopPidFile(f)).toMatch(/^nothing to stop/);
		expect(running(k.pid!)).toBe(true);
	});

	it('stops the recorded process and leaves a bystander running the same command', async () => {
		const target = sleeper(), bystander = sleeper();
		const f = join(dir, 'pid');
		writePidFile(f, target.pid);
		expect(await stopPidFile(f, { graceMs: 2000 })).toMatch(/^stopped process \d+ \(SIGTERM\)$/);
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
		expect(await stopPidFile(f, { group: true, graceMs: 2000 })).toMatch(/^stopped process group/);
		expect(processStart(grandchild)).toBeNull();
		expect(running(bystander.pid!)).toBe(true);
	});

	it('escalates to SIGKILL when SIGTERM is ignored', async () => {
		const k = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 0.1; done'], { stdio: 'ignore' });
		kids.push(k);
		await new Promise((r) => setTimeout(r, 200));
		const f = join(dir, 'pid');
		writePidFile(f, k.pid);
		expect(await stopPidFile(f, { graceMs: 500 })).toMatch(/SIGKILL after SIGTERM\)$/);
	});
});
