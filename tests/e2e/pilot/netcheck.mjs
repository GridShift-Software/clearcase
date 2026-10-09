#!/usr/bin/env bun
// Bind check in the HOST network namespace (run outside unshare): the production server listens on 127.0.0.1 only,
// for both the app and the originals site, and refuses connections on every other interface address and on ::1.
// No browser, no outbound traffic: connections go only to this machine's own addresses.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorder } from './lib/record.mjs';
import { BUN, bunIdentity, portOpen, startServer } from './lib/server.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const R = recorder('netcheck', { bun: bunIdentity() });
const tryConnect = (port, host) => new Promise((res) => {
	const s = net.connect({ port, host });
	const t = setTimeout(() => { s.destroy(); res('TIMEOUT'); }, 1500);
	s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
	s.once('error', (e) => { clearTimeout(t); res(e.code); });
});
const port = Number(process.env.E2E_NETCHECK_PORT ?? 42990);
const dataDir = mkdtempSync(join(tmpdir(), 'cc-netcheck-'));
await R.step('NET-BIND', 'app and originals listen on 127.0.0.1 only; every other local address and ::1 is refused', async () => {
	const srv = await startServer({ root, port, origPort: port + 1, dataDir, logFile: join(dataDir, 'server.log') });
	try {
		const listening = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' }).split('\n').filter((l) => new RegExp(`:(${port}|${port + 1})\\b`).test(l)).map((l) => l.trim().split(/\s+/)[3]);
		const addrs = Object.entries(networkInterfaces()).flatMap(([n, xs]) => (xs ?? []).filter((x) => !x.internal && !(x.family === 'IPv6' && x.address.startsWith('fe80'))).map((x) => ({ n, addr: x.address })));
		const external = {};
		for (const { n, addr } of addrs) for (const p of [port, port + 1]) external[`${n} ${addr}:${p}`] = await tryConnect(p, addr);
		const v6 = { app: await tryConnect(port, '::1'), orig: await tryConnect(port + 1, '::1') };
		const stop = await srv.stop();
		const pass = listening.length === 2 && listening.every((l) => l.startsWith('127.0.0.1:')) && Object.values(external).every((x) => x !== true) && v6.app !== true && v6.orig !== true && stop.graceful;
		return { pass, evidence: { listening, externalAttempts: Object.keys(external).length, accepted: Object.values(external).filter((x) => x === true).length, v6, stop } };
	} finally { await srv.stop().catch(() => {}); }
});
// adapter-node's own entry (bun build/index.js, HOST unset) must not become a second way to serve the app on every
// interface: it refuses to start, so nothing listens on its ports (PRFIX-6b, M1 gate finding F1).
await R.step('NET-ENTRY', 'bun build/index.js with HOST unset never listens on a non-loopback address', async () => {
	const [p, op] = [port + 2, port + 3];
	const proc = spawn(BUN, [join(root, 'build', 'index.js')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
		env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(p), ORIGINALS_PORT: String(op), CLEARCASE_DATA_DIR: join(dataDir, 'entry') } });
	let out = '';
	let exit = null;
	proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
	proc.once('exit', (code, sig) => { exit = { code, sig }; });
	try {
		for (let t = Date.now(); !exit && (await portOpen(p)) !== true && Date.now() - t < 15000; ) await new Promise((r) => setTimeout(r, 50));
		await new Promise((r) => setTimeout(r, 500));
		const listening = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' }).split('\n').filter((l) => new RegExp(`:(${p}|${op})\\b`).test(l)).map((l) => l.trim().split(/\s+/)[3]);
		const addrs = Object.values(networkInterfaces()).flatMap((xs) => (xs ?? []).filter((x) => !x.internal && !(x.family === 'IPv6' && x.address.startsWith('fe80'))).map((x) => x.address));
		const accepted = [];
		for (const a of addrs) if ((await tryConnect(p, a)) === true) accepted.push(`${a}:${p}`);
		const pass = listening.every((l) => l.startsWith('127.0.0.1:')) && accepted.length === 0;
		return { pass, evidence: { listening, accepted, externalAttempts: addrs.length, exit, message: out.split('\n').filter((l) => /FATAL|listening/i.test(l)).slice(0, 3) } };
	} finally { if (!exit) proc.kill('SIGKILL'); }
});
rmSync(dataDir, { recursive: true, force: true });
process.exit(R.finish() ? 0 : 1);
