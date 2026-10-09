// Export capture compares content: CSV and ICS as rows, JSON canonically, DOCX and PDF as text. Synthetic files only.
import { describe, expect, test } from 'vitest';
import { canonicalJson, docxText, parseCsv, parseDownload, parseIcs, pdfText, unzip } from '../../scripts/parity/lib/exports.mjs';
import { packageEntries, writeZip } from '../case-package/hostile/zip-writer';

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array | string) => Buffer.from(typeof b === 'string' ? enc(b) : b).toString('base64');

describe('CSV', () => {
	test('quotes, doubled quotes, CRLF and quoted newlines', () => {
		expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '']]);
	});
	test('a BOM and a missing final newline do not change the rows', () => {
		expect(parseCsv('﻿a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
	});
	test('a download becomes columns and rows', async () => {
		expect(await parseDownload({ name: 'x.csv', type: 'text/csv', base64: b64('ref,date\r\nSY-1,2020-01-02') })).toEqual({ name: 'x.csv', columns: ['ref', 'date'], rows: [['SY-1', '2020-01-02']] });
	});
});

describe('ICS', () => {
	test('events become rows over the union of property names; folded lines are unfolded', () => {
		const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261008\r\nSUMMARY:Synthetic\r\n  deadline\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261009\r\nEND:VEVENT\r\nEND:VCALENDAR';
		expect(parseIcs(ics)).toEqual({ columns: ['DTSTART', 'SUMMARY', 'UID'], rows: [['20261008', 'Synthetic deadline', 'a'], ['20261009', '', 'b']] });
	});
});

describe('JSON, DOCX and PDF', () => {
	test('JSON compares with sorted keys', () => {
		expect(canonicalJson('{"b":1,"a":{"d":2,"c":[{"f":1,"e":2}]}}')).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
	});
	const docx = (paras: string[]) => writeZip(packageEntries(new Map([
		['[Content_Types].xml', enc('<?xml version="1.0"?><Types/>')],
		['word/document.xml', enc(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.map((p) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${p}</w:t></w:r><w:r><w:tab/><w:t>end</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)],
	])));
	test('zip entries are read, deflated or stored', () => {
		expect([...unzip(docx(['x'])).keys()]).toEqual(['[Content_Types].xml', 'word/document.xml']);
	});
	test('DOCX text is its paragraphs, entities decoded, tabs as spaces', () => {
		expect(docxText(docx(['Synthetic &amp; heading', 'Second'])).split('\n')).toEqual(['Synthetic & heading end', 'Second end']);
	});
	test('PDF text comes from pdf.js', async () => {
		const stream = 'BT /F1 12 Tf 72 720 Td (Synthetic PDF text) Tj ET';
		const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
		let pdf = '%PDF-1.4\n';
		const offs: number[] = [];
		objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
		const x = pdf.length;
		pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
		expect(await pdfText(Buffer.from(pdf, 'latin1'))).toBe('Synthetic PDF text');
	});
	test('other downloads become normalized text', async () => {
		expect(await parseDownload({ name: 'heads.txt', type: 'text/plain', base64: b64('Synthetic\n\n  heads ') })).toEqual({ name: 'heads.txt', text: 'Synthetic heads' });
	});
});
