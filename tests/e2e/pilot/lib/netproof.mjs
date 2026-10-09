// Proof, from inside the process that runs the server and the browser, that loopback works and nothing leaves the
// machine: only lo exists, TCP to public addresses (IPv4 and IPv6) fails at once, DNS resolution fails, and a
// loopback listener accepts. Any success of an outbound attempt is a failure of the run.
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { readlinkSync } from 'node:fs';

const tryConnect = (host, port, timeout = 1500) => new Promise((res) => {
	const s = net.connect({ host, port });
	const t = setTimeout(() => { s.destroy(); res('TIMEOUT'); }, timeout);
	s.once('connect', () => { clearTimeout(t); s.destroy(); res('CONNECTED'); });
	s.once('error', (e) => { clearTimeout(t); res(e.code ?? String(e)); });
});

export async function proveOffline() {
	const r = { netns: readlinkSync('/proc/self/ns/net'), offlineEnv: process.env.CLEARCASE_OFFLINE === '1', links: null, outbound: {}, dns: null, loopback: null };
	try { r.links = execFileSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.split(': ')[1]?.split('@')[0]); } catch (e) { r.links = `ip failed: ${e.message}`; }
	for (const [h, p] of [['1.1.1.1', 443], ['8.8.8.8', 53], ['93.184.215.14', 80], ['2606:4700:4700::1111', 443]]) r.outbound[`${h}:${p}`] = await tryConnect(h, p);
	r.dns = await lookup('example.com').then((x) => `RESOLVED ${x.address}`, (e) => e.code ?? String(e));
	const srv = net.createServer((s) => s.end('ok'));
	await new Promise((res) => srv.listen(0, '127.0.0.1', res));
	r.loopback = await tryConnect('127.0.0.1', srv.address().port);
	await new Promise((res) => srv.close(res));
	r.pass = r.offlineEnv && Array.isArray(r.links) && r.links.length === 1 && r.links[0] === 'lo' &&
		Object.values(r.outbound).every((x) => x !== 'CONNECTED' && x !== 'TIMEOUT') && !String(r.dns).startsWith('RESOLVED') && r.loopback === 'CONNECTED';
	return r;
}
