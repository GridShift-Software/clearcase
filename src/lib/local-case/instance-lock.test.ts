// The instance lock on a data directory: a live owner recorded in instance.pid (pid plus kernel start time) refuses a
// second process even when instance.lock was unlinked under it, without the refused process writing anything; a
// stale record (dead pid, or a reused pid with another start time) does not; and a lock error that is not a lock
// conflict (such as a full disk) is not blamed on another process.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Storage } from './db.server.ts';
import { cleanup, tempRoot } from './test-support.ts';

const startOf = (pid: number) => { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]!; };
let root = '';
let child: ChildProcess | null = null;
afterEach(async () => {
	child?.kill('SIGKILL');
	child = null;
	if (root) await cleanup(root);
});
const live = async () => { child = spawn('sleep', ['60'], { stdio: 'ignore' }); await new Promise((r) => child!.once('spawn', r)); return child.pid!; };

it('a live owner recorded in instance.pid refuses a second instance after instance.lock was removed, and nothing is written', async () => {
	root = await tempRoot('lock');
	const data = path.join(root, 'data');
	mkdirSync(data);
	const pid = await live();
	writeFileSync(path.join(data, 'instance.pid'), `${pid} ${startOf(pid)}\n`);
	const r = new Storage(data).acquireInstanceLock();
	expect(r.ok).toBe(false);
	expect(r.ok ? '' : r.reason).toMatch(new RegExp(`another ClearCase process \\(pid ${pid}\\) is using the data directory .*still running`));
	expect(readdirSync(data)).toEqual(['instance.pid']);
	expect(readFileSync(path.join(data, 'instance.pid'), 'utf8')).toBe(`${pid} ${startOf(pid)}\n`);
});

it('a stale instance.pid (a dead pid, or a live pid with another start time) does not block, and a clean release removes it', async () => {
	root = await tempRoot('lock');
	const data = path.join(root, 'data');
	mkdirSync(data);
	const pid = await live();
	for (const record of [`${pid} 1`, '2147483646 12345', `${pid}`]) {
		writeFileSync(path.join(data, 'instance.pid'), `${record}\n`);
		const s = new Storage(data);
		expect([record, s.acquireInstanceLock()]).toEqual([record, { ok: true }]);
		expect(readFileSync(path.join(data, 'instance.pid'), 'utf8')).toBe(`${process.pid} ${startOf(process.pid)}\n`);
		s.releaseInstanceLock();
		expect(existsSync(path.join(data, 'instance.pid'))).toBe(false);
	}
});

it('a lock error that is not a lock conflict is reported as such, not blamed on another process', async () => {
	root = await tempRoot('lock');
	const data = path.join(root, 'data');
	mkdirSync(path.join(data, 'instance.lock'), { recursive: true });
	writeFileSync(path.join(data, 'instance.pid'), '2147483646 12345\n');
	const r = new Storage(data).acquireInstanceLock();
	expect(r.ok).toBe(false);
	expect(r.ok ? '' : r.reason).toMatch(/^ClearCase cannot take the instance lock in the data directory /);
	expect(r.ok ? '' : r.reason).not.toMatch(/another ClearCase process/);
});
