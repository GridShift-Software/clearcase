// Raw TCP canary on 127.0.0.1:$CANARY_PORT (ported from the hardened pilot prototype). Every connection is an
// exfiltration or execution signal:
// payload scripts call it directly, and Chrome maps every non-loopback hostname here (--host-resolver-rules).
import net from 'node:net';
import { CANARY_PORT } from './cdp.mjs';

function sni(buf) {
	// TLS ClientHello: find server_name extension (type 0x0000) and return the host.
	try {
		if (buf[0] !== 0x16) return null;
		let p = 5 + 4 + 2 + 32; // record hdr, handshake hdr, version, random
		p += 1 + buf[p]; // session id
		p += 2 + buf.readUInt16BE(p); // cipher suites
		p += 1 + buf[p]; // compression
		const end = p + 2 + buf.readUInt16BE(p);
		p += 2;
		while (p + 4 <= end) {
			const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2);
			if (type === 0) return buf.subarray(p + 9, p + 9 + buf.readUInt16BE(p + 7)).toString('latin1');
			p += 4 + len;
		}
	} catch {}
	return null;
}

export function startCanary() {
	const hits = [];
	const server = net.createServer((sock) => {
		sock.once('data', (buf) => {
			const head = buf.subarray(0, 600).toString('latin1');
			const http = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/.exec(head);
			const host = /\r\nhost: *([^\r\n]+)/i.exec(head)?.[1];
			const origin = /\r\norigin: *([^\r\n]+)/i.exec(head)?.[1];
			const referer = /\r\nreferer: *([^\r\n]+)/i.exec(head)?.[1];
			hits.push({ at: Date.now(), kind: http ? 'http' : buf[0] === 0x16 ? 'tls' : 'raw', method: http?.[1], path: http?.[2], host, origin, referer, sni: sni(buf) });
			if (http) sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			else sock.destroy();
		});
		sock.on('error', () => {});
		sock.setTimeout(3000, () => sock.destroy());
	});
	return new Promise((res) => server.listen(CANARY_PORT, '127.0.0.1', () => res({ hits, close: () => new Promise((r) => server.close(r)) })));
}
