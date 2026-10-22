// Node preload for the deployment probe (GRS-107): appends one line to $PROBE_NET_LOG for every socket connect and DNS
// lookup this process makes, before the call, so an attempt is recorded even when the namespace refuses it. Loopback
// and local sockets are recorded too; the runner decides which count as network.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.PROBE_NET_LOG;
const record = (kind, target) => log && appendFileSync(log, `${JSON.stringify({ pid: process.pid, kind, target })}\n`);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const o = Array.isArray(args[0]) ? args[0][0] : args[0];
	const target = typeof o === 'object' && o !== null ? (o.path ?? `${o.host ?? 'localhost'}:${o.port}`) : typeof o === 'string' && !/^\d+$/.test(o) ? o : `${args[1] ?? 'localhost'}:${o}`;
	record('connect', String(target));
	return connect.apply(this, args);
};
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
	const original = dns[name];
	dns[name] = function (host, ...rest) {
		record(`dns.${name}`, String(host));
		return original.call(this, host, ...rest);
	};
	const promised = dns.promises[name];
	dns.promises[name] = function (host, ...rest) {
		record(`dns.promises.${name}`, String(host));
		return promised.call(this, host, ...rest);
	};
}
syncBuiltinESMExports();
