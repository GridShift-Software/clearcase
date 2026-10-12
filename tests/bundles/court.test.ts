// Court Bundle index rules (v5 cbPad, cbRange, cbDesc, cbTot, cbHdr, cbSlug), the stored ZIP with CRC-32, and the Word
// index, on synthetic bundles.
import { describe, expect, it } from 'vitest';
import { docxText, unzip } from '../../scripts/parity/lib/exports.mjs';
import { PLACEHOLDER, TO_COMPLETE, bundlesOf, cleanName, desc, header, headerRaw, indexFileName, pad, partRange, range, slug, totals } from '../../src/lib/views/bundles/court';
import { indexDocx } from '../../src/lib/views/bundles/docx';
import { crc32, storedZip } from '../../src/lib/views/bundles/zip';

const enc = (s: string) => new TextEncoder().encode(s);
const data = { list: [{ no: '1', name: 'Synthetic Bundle', title: '', note: 'n', pages: 7, indexPages: 2, file: './B/b.pdf', indexFile: '', rows: [
	{ n: 1, key: 'OD-1', desc: 'Letter of demand', date: '3 February 2001', pages: 3, from: 5, to: 7, parts: [{ url: './X/a.pdf', name: '(1) a.pdf', from: 2, to: 4 }] },
	{ n: 2, key: 'OD-2', desc: '', date: '', pages: 0, from: 0, to: 0, parts: [] },
	{ n: 3, key: 'OD-3', desc: 'Blank page', blank: true, pages: 0, from: 0, to: 0, parts: [] },
] }, 'not a bundle'] };

describe('court bundle index rules', () => {
	it('pads and ranges like v5', () => {
		expect(pad(7)).toBe('007');
		expect(pad(1234)).toBe('1234');
		expect(range({ pages: 3, from: 5, to: 7 })).toBe('005 – 007');
		expect(range({ pages: 1, from: 12, to: 12 })).toBe('012');
		expect(range({ pages: 0, from: 5, to: 5 })).toBe('');
	});
	it('describes rows upper-cased, never repeating the date, with the to-be-completed marker', () => {
		expect(desc({ desc: 'Letter of demand', date: '3 February 2001' })).toBe('LETTER OF DEMAND – 3 FEBRUARY 2001');
		expect(desc({ desc: 'Letter 3 February 2001', date: '3 February 2001' })).toBe('LETTER 3 FEBRUARY 2001');
		expect(desc({ desc: '  ', date: '' })).toBe(TO_COMPLETE);
	});
	it('reads bundles from untrusted data, with v5 defaults and totals', () => {
		const [b] = bundlesOf(data);
		expect(bundlesOf(data)).toHaveLength(1);
		expect(b!.title).toBe('(1) Synthetic Bundle');
		expect(totals(b!)).toEqual({ items: 3, pages: 7, missing: 1, blank: 1 });
		expect(bundlesOf(null)).toEqual([]);
	});
	it('overlays the stored header on the imported defaults; blanks print placeholders', () => {
		const raw = headerRaw({ court: 'X', judge: 'J' }, { court: '' });
		const { h, blank } = header(raw);
		expect(h.court).toBe(PLACEHOLDER.court);
		expect(h.judge).toBe('J');
		expect(blank).toContain('court');
		expect(blank).not.toContain('judge');
		expect(header(headerRaw({ court: 'X' }, null)).h.court).toBe('X');
	});
	it('names files like v5', () => {
		expect(slug('Expert Reports (Vol. 2)')).toBe('Expert_Reports_Vol_2');
		expect(indexFileName({ no: '6b', name: 'Synthetic Bundle' })).toBe('Index_6b_Synthetic_Bundle.docx');
		expect(cleanName('(12) Letter.pdf')).toBe('Letter');
		expect(partRange({ url: '', name: '', from: 2, to: 4 })).toBe('pp 2–4 of source');
		expect(partRange({ url: '', name: '', from: 3, to: 3 })).toBe('p 3 of source');
	});
});

describe('stored zip and the Word index', () => {
	it('computes the standard CRC-32 check value', () => {
		expect(crc32(enc('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
	});
	it('writes a readable stored archive in entry order', () => {
		const z = storedZip([{ name: 'a.txt', data: enc('hello') }, { name: 'dir/b.xml', data: enc('<x/>') }]);
		const m = unzip(z);
		expect([...m.keys()]).toEqual(['a.txt', 'dir/b.xml']);
		expect(Buffer.from(m.get('a.txt')!).toString()).toBe('hello');
	});
	it('writes one paragraph per header line, party labels after a tab, and the index table, escaping every value', () => {
		const [b] = bundlesOf(data);
		const { h } = header(headerRaw({ court: 'COURT <&>', judge: 'DIV', intro: 'Between:', caseNo: '1/2', claimant: 'ONE\nTWO', claimantRole: 'APPLICANT', defendant: 'THREE', defendantRole: '' }, null));
		const bytes = indexDocx([b!, b!], h, 'Synthetic "creator"');
		const lines = docxText(bytes).split('\n');
		expect(lines.slice(0, 13)).toEqual(['COURT <&>', 'DIV', 'CASE NUMBER: 1/2', 'Between:', 'ONE APPLICANT', 'TWO', 'and', 'THREE DEFENDANT', 'INDEX', '(1) Synthetic Bundle', '1.', 'LETTER OF DEMAND – 3 FEBRUARY 2001', '005 – 007']);
		expect(lines).toContain(TO_COMPLETE);
		const files = unzip(bytes);
		expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
		const core = Buffer.from(files.get('docProps/core.xml')!).toString();
		expect(core).toContain('<dc:title>Court bundle indexes</dc:title><dc:creator>Synthetic &quot;creator&quot;</dc:creator>');
		expect(Buffer.from(files.get('word/document.xml')!).toString().match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
	});
});
