// Pid files for `gate --stop` and `start --stop`, so an agent stops only the run it started and never matches another
// worktree's gate or server by command line (`pkill -f`). A pid file holds `<pid> <start time>`, the start time being
// field 22 of /proc/<pid>/stat, so a pid the kernel has since reused for another process is never signalled. Linux only:
// elsewhere `processStart` returns null and nothing is ever stopped.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Stat = { pgrp: number; state: string; start: string };

function stat(pid: number): Stat | null {
	try {
		// The command name in parentheses may hold spaces, so split after its closing parenthesis.
		const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
		return { state: f[0], pgrp: Number(f[2]), start: f[19] };
	} catch {
		return null;
	}
}

/** The process's start time in clock ticks since boot, or null when it does not exist. */
export const processStart = (pid: number): string | null => stat(pid)?.start ?? null;

/** Whether `pid` is a live process (not a zombie) started at `start`. */
const alive = (pid: number, start: string) => {
	const s = stat(pid);
	return !!s && s.state !== 'Z' && s.start === start;
};

/** Whether any live process is in process group `pgid`. */
function groupAlive(pgid: number): boolean {
	for (const e of readdirSync('/proc')) {
		if (!/^\d+$/.test(e)) continue;
		const s = stat(Number(e));
		if (s && s.pgrp === pgid && s.state !== 'Z') return true;
	}
	return false;
}

/** Records this process in `file`. */
export function writePidFile(file: string, pid = process.pid): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${pid} ${processStart(pid)}\n`);
}

/** Reads `file` as `{ pid, start }`, or null when it is missing or malformed. */
export function readPidFile(file: string): { pid: number; start: string } | null {
	try {
		const [pid, start] = readFileSync(file, 'utf8').trim().split(' ');
		return /^\d+$/.test(pid) && /^\d+$/.test(start ?? '') ? { pid: Number(pid), start } : null;
	} catch {
		return null;
	}
}

/** Removes `file` if it still names `pid` (a later run may have replaced it). */
export function removePidFile(file: string, pid = process.pid): void {
	if (readPidFile(file)?.pid === pid) rmSync(file, { force: true });
}

/** The live process `file` names, or null (a stale file is removed). */
export function livePid(file: string): { pid: number; start: string } | null {
	const rec = readPidFile(file);
	if (rec && alive(rec.pid, rec.start)) return rec;
	if (existsSync(file)) rmSync(file, { force: true });
	return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stops the process `file` names with SIGTERM, then SIGKILL after `graceMs`. With `group`, the pid is a process group
 * leader and the whole group is signalled; only a group whose leader is still the recorded process is touched.
 * Returns a one-line outcome. A missing or stale file stops nothing.
 */
export async function stopPidFile(file: string, { group = false, graceMs = 10_000 } = {}): Promise<string> {
	const rec = livePid(file);
	if (!rec) return `nothing to stop: no live process in ${file}`;
	const target = group ? -rec.pid : rec.pid;
	const gone = () => (group ? !groupAlive(rec.pid) : !alive(rec.pid, rec.start));
	const signal = (sig: NodeJS.Signals) => { try { process.kill(target, sig); } catch {} };
	signal('SIGTERM');
	for (let t = 0; t < graceMs && !gone(); t += 100) await sleep(100);
	let how = 'SIGTERM';
	if (!gone()) {
		signal('SIGKILL');
		how = 'SIGKILL after SIGTERM';
		for (let t = 0; t < 5000 && !gone(); t += 100) await sleep(100);
	}
	rmSync(file, { force: true });
	return `stopped ${group ? 'process group' : 'process'} ${rec.pid} (${how})${gone() ? '' : ', but it is still running'}`;
}
