#!/usr/bin/env bun
// Bind check in the HOST network namespace (run outside unshare): the production server listens on 127.0.0.1 only,
// for both the app and the originals site, and refuses connections on every other interface address and on ::1.
// No browser, no outbound traffic: connections go only to this machine's own addresses.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorder } from './lib/record.mjs';
import { bunIdentity, startServer } from './lib/server.mjs';

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
rmSync(dataDir, { recursive: true, force: true });
process.exit(R.finish() ? 0 : 1);
