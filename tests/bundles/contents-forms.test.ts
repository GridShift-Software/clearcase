// Page-key forms the assembler must keep (PR #22 review, P1): a page whose /Contents is an indirect array, a direct
// array or an indirect single stream keeps its own content after open -> assemble; an indirect /Rotate is honoured.
// Read back with pdf.js, not our own parser.
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { assemble, open } from '../../src/lib/bundles/pdf/index.ts';

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** A classic-xref PDF from object bodies 1..n (objs[0] is object 1); a string body, or `{ dict, data }` for a stream. */
function pdf(objs: (string | { dict: string; data: string })[]): Uint8Array {
	let out = '%PDF-1.4\n';
	const offs: number[] = [];
	objs.forEach((o, i) => {
		offs.push(out.length);
		out += `${i + 1} 0 obj\n${typeof o === 'string' ? o : `<< ${o.dict} /Length ${o.data.length} >>\nstream\n${o.data}\nendstream`}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
	return latin1(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

const draw = (t: string) => ({ dict: '', data: `BT /F1 24 Tf 72 700 Td (${t}) Tj ET` });
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const TREE = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const CAT = '<< /Type /Catalog /Pages 2 0 R >>';
const page = (extra: string) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> ${extra} >>`;

/** The one-page documents: object 5.. are the content streams (and the array, when indirect). */
const forms = {
	'an indirect array of streams': pdf([CAT, TREE, page('/Contents 7 0 R'), FONT, draw('ORIGINAL '), draw('EVIDENCE'), '[5 0 R 6 0 R]']),
	'a direct array of streams': pdf([CAT, TREE, page('/Contents [5 0 R 6 0 R]'), FONT, draw('ORIGINAL '), draw('EVIDENCE')]),
	'an indirect single stream': pdf([CAT, TREE, page('/Contents 5 0 R'), FONT, draw('ORIGINAL EVIDENCE')]),
};

const textOf = async (bytes: Uint8Array) => {
	const d = await getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
	const pg = await d.getPage(1);
	const items = (await pg.getTextContent()).items.flatMap((x) => ('str' in x ? [x] : []));
	return { text: items.map((x) => x.str).join(''), items, rotate: pg.rotate };
};

describe('assemble keeps the original /Contents', () => {
	for (const [name, bytes] of Object.entries(forms)) {
		it(`with ${name}`, async () => {
			expect((await textOf(bytes)).text).toContain('ORIGINAL');
			const a = await assemble([{ doc: await open(bytes), from: 1, to: 1 }]);
			const after = await textOf(a.bytes);
			expect(after.text).toContain('ORIGINAL');
			expect(after.text).toContain('EVIDENCE');
			expect(after.text).toContain('1'); // the stamp
		});
	}
});

describe('assemble reads an indirect /Rotate in source space', () => {
	it('rotates the stamp with /Rotate 90 held by object 8', async () => {
		// object 8 is the rotation in the source; in the output, object 8 is some other object
		const src = pdf([CAT, TREE, page('/Contents 5 0 R /Rotate 8 0 R'), FONT, draw('ORIGINAL EVIDENCE'), '<< >>', '<< >>', '90']);
		const a = await assemble([{ doc: await open(src), from: 1, to: 1 }]);
		const r = await textOf(a.bytes);
		expect(r.rotate).toBe(90);
		const stamp = r.items.find((x) => x.str === '1');
		// a stamp turned a quarter: the text matrix runs up the page
		expect(stamp?.transform.slice(0, 4).map(Math.round)).toEqual([0, 11, -11, 0]);
	});
});
