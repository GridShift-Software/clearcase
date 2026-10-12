// Synthetic PDFs for the Court Bundle builder's tests, e2e scenario, parity sweep and timing (GRS-19). Nothing here
// comes from a case: every page says "Synthetic <name> page <i>". Each option exercises one path of the PDF engine.
//
//   bun tests/bundles/fixtures/make-pdfs.mjs <out-dir>   writes the standard set (SET below) into <out-dir>
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const concat = (parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
};
const stream = (dict, data) => ({ dict, data: typeof data === 'string' ? latin1(data) : data });
const body = (v) => (typeof v === 'string' ? [latin1(v)] : [latin1(`<< ${v.dict} /Length ${v.data.length} >>\nstream\n`), v.data, latin1('\nendstream')]);

/**
 * One PDF.
 * @param {object} o
 * @param {string} o.name        printed on every page
 * @param {number} [o.pages=1]
 * @param {number} [o.rotate]    /Rotate on every page
 * @param {number[]} [o.cropBox] a CropBox inside the A4 MediaBox
 * @param {boolean} [o.form]     page text drawn by a Form XObject that has no /Resources of its own
 * @param {boolean} [o.inherit]  MediaBox and Resources on the page tree, not the pages
 * @param {boolean} [o.objStm]   dictionaries in an object stream, an xref stream, Flate contents
 * @param {boolean} [o.encrypt]  an /Encrypt entry in the trailer
 * @returns {Uint8Array}
 */
export function makePdf(o) {
	const n = o.pages ?? 1;
	const objs = [null];
	const add = (v) => objs.push(v) - 1;
	const cat = add(null), tree = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	// The form borrows /F2 from the page: only the page's /Resources name it, and the page's own content never does.
	const bold = o.form ? add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>') : 0;
	const form = o.form ? add(stream('/Type /XObject /Subtype /Form /BBox [0 0 595 842]', 'BT /F2 11 Tf 72 90 Td (Drawn by a form XObject) Tj ET')) : 0;
	const res = `<< /Font << /F1 ${font} 0 R${bold ? ` /F2 ${bold} 0 R` : ''} >>${form ? ` /XObject << /X1 ${form} 0 R >>` : ''} >>`;
	const kids = [];
	for (let i = 1; i <= n; i++) {
		const text = `BT /F1 24 Tf 72 760 Td (Synthetic ${o.name} page ${i}) Tj ET`;
		const ops = o.form ? `q /X1 Do Q\n${text}` : text;
		const content = add(o.objStm ? stream('/Filter /FlateDecode', deflateSync(latin1(ops))) : stream('', ops));
		let d = `<< /Type /Page /Parent ${tree} 0 R /Contents ${content} 0 R`;
		if (!o.inherit) d += ` /MediaBox [0 0 595 842] /Resources ${res}`;
		if (o.rotate) d += ` /Rotate ${o.rotate}`;
		if (o.cropBox) d += ` /CropBox [${o.cropBox.join(' ')}]`;
		kids.push(add(d + ' >>'));
	}
	objs[cat] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
	objs[tree] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${n}${o.inherit ? ` /MediaBox [0 0 595 842] /Resources ${res}` : ''} >>`;
	const enc = o.encrypt ? ' /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >> /ID [<01><01>]' : '';
	return o.objStm ? withObjStm(objs, cat, enc) : classic(objs, cat, enc);
}

function classic(objs, root, extra) {
	const parts = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
	let len = parts[0].length;
	const offs = [];
	for (let i = 1; i < objs.length; i++) {
		offs[i] = len;
		for (const b of [latin1(`${i} 0 obj\n`), ...body(objs[i]), latin1('\nendobj\n')]) { parts.push(b); len += b.length; }
	}
	let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
	for (let i = 1; i < objs.length; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
	x += `trailer\n<< /Size ${objs.length} /Root ${root} 0 R${extra} >>\nstartxref\n${len}\n%%EOF\n`;
	parts.push(latin1(x));
	return concat(parts);
}

/** Dictionaries go into one object stream; streams stay outside; a Flate xref stream with /W [1 4 2] closes the file. */
function withObjStm(objs, root, extra) {
	const stmNo = objs.length, xrefNo = objs.length + 1, size = objs.length + 2;
	const inStm = [];
	for (let i = 1; i < objs.length; i++) if (typeof objs[i] === 'string') inStm.push(i);
	let head = '', bodyS = '';
	for (const i of inStm) { head += `${i} ${bodyS.length} `; bodyS += objs[i] + '\n'; }
	const stm = stream(`/Type /ObjStm /N ${inStm.length} /First ${head.length} /Filter /FlateDecode`, deflateSync(latin1(head + bodyS)));
	const parts = [latin1('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')];
	let len = parts[0].length;
	const entry = new Map();
	const put = (i, v) => {
		entry.set(i, [1, len, 0]);
		for (const b of [latin1(`${i} 0 obj\n`), ...body(v), latin1('\nendobj\n')]) { parts.push(b); len += b.length; }
	};
	for (let i = 1; i < objs.length; i++) if (typeof objs[i] !== 'string') put(i, objs[i]);
	put(stmNo, stm);
	inStm.forEach((i, k) => entry.set(i, [2, stmNo, k]));
	const xrefAt = len;
	entry.set(xrefNo, [1, xrefAt, 0]);
	const rows = new Uint8Array(size * 7);
	for (let i = 0; i < size; i++) {
		const [t, f2, f3] = entry.get(i) ?? [0, 0, 0xffff];
		rows.set([t, (f2 >>> 24) & 255, (f2 >>> 16) & 255, (f2 >>> 8) & 255, f2 & 255, (f3 >> 8) & 255, f3 & 255], i * 7);
	}
	const xs = stream(`/Type /XRef /Size ${size} /W [1 4 2] /Root ${root} 0 R /Filter /FlateDecode${extra}`, deflateSync(rows));
	for (const b of [latin1(`${xrefNo} 0 obj\n`), ...body(xs), latin1('\nendobj\n')]) parts.push(b);
	parts.push(latin1(`startxref\n${xrefAt}\n%%EOF\n`));
	return concat(parts);
}

/** The standard set: the e2e scenario and the parity sweep pick from these. */
export const SET = {
	'Alpha_Statement.pdf': { name: 'Alpha', pages: 3 },
	'Beta_Letter.pdf': { name: 'Beta', pages: 2, rotate: 90, cropBox: [40, 60, 555, 800] },
	'Gamma_Report.pdf': { name: 'Gamma', pages: 4, objStm: true, form: true, inherit: true },
	'Locked.pdf': { name: 'Locked', pages: 1, encrypt: true },
};

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) throw new Error('usage: make-pdfs.mjs <out-dir>');
	mkdirSync(dir, { recursive: true });
	for (const [file, o] of Object.entries(SET)) writeFileSync(join(dir, file), makePdf(o));
}
