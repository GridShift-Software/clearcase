// Export capture parsing: downloads are compared by content, never by bytes. CSV and ICS become columns and rows,
// JSON becomes canonical text (sorted keys), DOCX and PDF become their visible text, TXT and print captures become
// normalized text. Tested in tests/parity/exports.test.ts.
import { inflateRawSync } from 'node:zlib';
import { ws } from './normalize.mjs';

/** RFC 4180 CSV (quotes doubled, CRLF or LF rows, quoted newlines kept); a leading BOM is dropped. */
export function parseCsv(text) {
	const s = text.replace(/^﻿/, '');
	const rows = [];
	let row = [], cell = '', q = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
		if (c === '"') q = true;
		else if (c === ',') { row.push(cell); cell = ''; }
		else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
		else cell += c;
	}
	if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
	return rows;
}

/** iCalendar: unfold continuation lines, then one row per VEVENT with the union of property names as columns. */
export function parseIcs(text) {
	const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
	const events = [];
	let cur = null;
	for (const l of lines) {
		if (l === 'BEGIN:VEVENT') cur = {};
		else if (l === 'END:VEVENT') { events.push(cur); cur = null; }
		else if (cur) { const i = l.indexOf(':'); const name = l.slice(0, i).split(';')[0]; cur[name] = l.slice(i + 1); }
	}
	const columns = [...new Set(events.flatMap((e) => Object.keys(e)))].sort();
	return { columns, rows: events.map((e) => columns.map((c) => e[c] ?? '')) };
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const canonicalJson = (text) => JSON.stringify(sortKeys(JSON.parse(text)));

/** Entries of a ZIP archive (stored or deflated), from its central directory. */
export function unzip(buf) {
	const b = Buffer.from(buf);
	let eocd = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error('not a zip archive');
	const n = b.readUInt16LE(eocd + 10);
	let p = b.readUInt32LE(eocd + 16);
	const out = new Map();
	for (let k = 0; k < n; k++) {
		if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
		const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
		const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
		const lnlen = b.readUInt16LE(off + 26), lxlen = b.readUInt16LE(off + 28);
		const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
		out.set(name, method === 0 ? data : method === 8 ? inflateRawSync(data) : null);
		p += 46 + nlen + xlen + clen;
	}
	return out;
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** DOCX: paragraphs of word/document.xml, one per line (tabs and breaks as spaces). */
export function docxText(buf) {
	const doc = unzip(buf).get('word/document.xml');
	if (!doc) throw new Error('no word/document.xml');
	const xml = doc.toString('utf8');
	const runs = (p) => [...p.replace(/<w:(tab|br)\/>/g, '<w:t> </w:t>').matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('');
	return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => ws(xmlText(runs(m[0])))).filter(Boolean).join('\n');
}

/** PDF: text of every page with pdf.js (the app's pinned pdfjs-dist), lines joined per page. */
export async function pdfText(buf) {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
	const doc = await task.promise;
	const pages = [];
	for (let i = 1; i <= doc.numPages; i++) pages.push(ws((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('')));
	await task.destroy();
	return pages.join('\n');
}

/**
 * One captured download as an export snapshot entry: { name, columns, rows } for tables, { name, text } otherwise.
 * `d` is { name, type, base64 } from the page hooks (scripts/parity/lib/browser.mjs).
 */
export async function parseDownload(d) {
	const buf = Buffer.from(d.base64, 'base64');
	const ext = (/\.([a-z0-9]+)$/i.exec(d.name)?.[1] ?? '').toLowerCase();
	const text = () => buf.toString('utf8');
	if (ext === 'csv' || /csv/.test(d.type)) { const [columns = [], ...rows] = parseCsv(text()); return { name: d.name, columns, rows }; }
	if (ext === 'ics' || /calendar/.test(d.type)) return { name: d.name, ...parseIcs(text()) };
	if (ext === 'json' || /json/.test(d.type)) { try { return { name: d.name, text: canonicalJson(text()) }; } catch { return { name: d.name, text: ws(text()) }; } }
	if (ext === 'docx') return { name: d.name, text: docxText(buf) };
	if (ext === 'pdf' || /pdf/.test(d.type)) return { name: d.name, text: await pdfText(buf) };
	return { name: d.name, text: ws(text()) };
}
