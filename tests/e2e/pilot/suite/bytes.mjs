// Synthetic bytes and raw HTTP for the browser suite (helpers for tests/e2e/pilot/suite.mjs only).
import net from 'node:net';

/**
 * A well-formed PDF (xref table, exact offsets) with one page per label; each page shows its label in Helvetica.
 * `catalog` adds entries to the catalog and `objects` appends numbered objects (from 100 up) for action tests.
 */
export function multiPagePdf(labels, { catalog = '', objects = {} } = {}) {
	const esc = (s) => s.replace(/[()\\]/g, '');
	const objs = new Map();
	const kids = labels.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
	objs.set(1, `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`);
	objs.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${labels.length} >>`);
	objs.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	labels.forEach((l, i) => {
		const content = `BT /F1 24 Tf 30 120 Td (${esc(l)}) Tj ET`;
		objs.set(4 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
		objs.set(5 + i * 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	});
	for (const [n, body] of Object.entries(objects)) objs.set(Number(n), body);
	const nums = [...objs.keys()].sort((a, b) => a - b);
	const size = nums.at(-1) + 1;
	let out = '%PDF-1.4\n';
	const offsets = new Map();
	for (const n of nums) { offsets.set(n, out.length); out += `${n} 0 obj\n${objs.get(n)}\nendobj\n`; }
	const xref = out.length;
	out += `xref\n0 ${size}\n0000000000 65535 f \n`;
	for (let n = 1; n < size; n++) out += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
	out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

/** One HTTP/1.1 request on a fresh socket with exactly these headers (fetch cannot set Host or Sec-Fetch-*). */
export function rawRequest(port, path, headers = {}, method = 'GET', body = null) {
	return new Promise((resolve, reject) => {
		const s = net.connect({ port, host: '127.0.0.1' });
		const chunks = [];
		const t = setTimeout(() => { s.destroy(); reject(new Error(`raw request timeout ${method} ${path}`)); }, 15000);
		s.once('connect', () => {
			const h = { connection: 'close', ...headers, ...(body !== null ? { 'content-length': Buffer.byteLength(body) } : {}) };
			s.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
			if (body !== null) s.write(body);
		});
		s.on('data', (c) => chunks.push(c));
		s.once('error', (e) => { clearTimeout(t); reject(e); });
		s.once('close', () => {
			clearTimeout(t);
			const buf = Buffer.concat(chunks);
			const end = buf.indexOf('\r\n\r\n');
			const head = buf.subarray(0, end < 0 ? buf.length : end).toString('latin1').split('\r\n');
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1] ?? 0);
			const hdrs = {};
			for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
			let rest = end < 0 ? Buffer.alloc(0) : buf.subarray(end + 4);
			if (/chunked/i.test(hdrs['transfer-encoding'] ?? '')) {
				const parts = [];
				for (let p = 0; p < rest.length;) {
					const nl = rest.indexOf('\r\n', p);
					const n = parseInt(rest.subarray(p, nl).toString('latin1'), 16);
					if (!n) break;
					parts.push(rest.subarray(nl + 2, nl + 2 + n));
					p = nl + 2 + n + 2;
				}
				rest = Buffer.concat(parts);
			}
			resolve({ status, headers: hdrs, body: rest, text: rest.toString('utf8') });
		});
	});
}
