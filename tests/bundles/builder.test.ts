// The Court Bundle builder's rules (v5 CBBLD): duplicate skipping, linking by file name, range clamping, the running
// plan, the saved bundle-list entry, C<i> numbering, and the v5 custom-bundle importer (GRS-19).
import { describe, expect, it } from 'vitest';
import {
	addFile, docxBundle, emptyBuilder, fromBundle, importV5CustomBundles, indexDocxName, indexPdfName, linkable, newRow, nextCustomNo, pdfName,
	plan, rowDel, rowMove, savedBundle, segAdd, segDel, segFile, setSeg, sourcesOf, spec, title, toBundle, unlinked, type Output,
} from '../../src/lib/bundles/builder.ts';
import { header, headerRaw } from '../../src/lib/views/bundles/court.ts';
import { indexDocx } from '../../src/lib/views/bundles/docx.ts';

const two = () => {
	const b = emptyBuilder();
	addFile(b, 'Alpha_Statement.pdf', 1000, 3);
	addFile(b, 'Beta_Letter.pdf', 2000, 2);
	return b;
};

describe('files', () => {
	it('adds each file once by name and size, with an item named after it', () => {
		const b = two();
		expect(addFile(b, 'Alpha_Statement.pdf', 1000, 3)).toBeNull();
		expect(addFile(b, 'Alpha_Statement.pdf', 1001, 3)?.id).toBe('f3');
		expect(b.files.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
		expect(b.rows.map((r) => r.desc)).toEqual(['ALPHA_STATEMENT', 'BETA_LETTER', 'ALPHA_STATEMENT']);
		expect(b.rows[0]!.segs).toEqual([{ fileId: 'f1', name: 'Alpha_Statement.pdf', from: 1, to: 3 }]);
	});
	it('a file attaches to waiting parts by lower-cased name, clamped, instead of adding an item', () => {
		const b = emptyBuilder();
		fromBundle(b, { name: 'Expert Reports', rows: [
			{ desc: 'REPORT', parts: [{ url: '', name: 'Report.PDF', from: 2, to: 9 }] } as never,
			{ desc: 'EMPTY', parts: [] } as never,
		] });
		expect(b.name).toBe('Expert Reports');
		expect(b.rows).toHaveLength(1);
		expect(unlinked(plan(b))).toHaveLength(1);
		addFile(b, 'report.pdf', 10, 4);
		expect(b.rows).toEqual([{ desc: 'REPORT', segs: [{ fileId: 'f1', name: 'Report.PDF', from: 2, to: 4 }] }]);
		expect(unlinked(plan(b))).toHaveLength(0);
	});
	it('starting from a bundle links files already added', () => {
		const b = two();
		fromBundle(b, { name: 'X', rows: [{ desc: 'B', parts: [{ url: '', name: 'beta_letter.pdf', from: 0, to: 0 }] } as never] });
		expect(b.rows).toEqual([{ desc: 'B', segs: [{ fileId: 'f2', name: 'beta_letter.pdf', from: 1, to: 1 }] }]);
	});
});

describe('items', () => {
	it('clamps typed page numbers to 1..pages and keeps to >= from', () => {
		const b = two();
		setSeg(b, 0, 0, 'from', 'abc');
		expect(b.rows[0]!.segs[0]).toMatchObject({ from: 1, to: 3 });
		setSeg(b, 0, 0, 'from', '9');
		expect(b.rows[0]!.segs[0]).toMatchObject({ from: 3, to: 3 });
		setSeg(b, 0, 0, 'from', '2');
		setSeg(b, 0, 0, 'to', '1');
		expect(b.rows[0]!.segs[0]).toMatchObject({ from: 2, to: 2 });
		setSeg(b, 0, 0, 'to', '-4');
		expect(b.rows[0]!.segs[0]).toMatchObject({ from: 2, to: 2 });
	});
	it('adds, re-points and removes ranges; an item without ranges goes', () => {
		const b = two();
		segAdd(b, 1);
		expect(b.rows[1]!.segs[1]).toEqual({ fileId: 'f1', name: 'Alpha_Statement.pdf', from: 1, to: 3 });
		segFile(b, 1, 1, 'f2');
		expect(b.rows[1]!.segs[1]).toEqual({ fileId: 'f2', name: 'Beta_Letter.pdf', from: 1, to: 2 });
		segDel(b, 0, 0);
		expect(b.rows.map((r) => r.desc)).toEqual(['BETA_LETTER']);
	});
	it('moves and deletes items; a new item needs a file', () => {
		const b = two();
		rowMove(b, 0, 1);
		expect(b.rows.map((r) => r.desc)).toEqual(['BETA_LETTER', 'ALPHA_STATEMENT']);
		rowMove(b, 1, 1);
		rowMove(b, 0, -1);
		expect(b.rows.map((r) => r.desc)).toEqual(['BETA_LETTER', 'ALPHA_STATEMENT']);
		expect(newRow(b)).toBe(true);
		expect(b.rows[2]).toEqual({ desc: '', segs: [{ fileId: 'f1', name: 'Alpha_Statement.pdf', from: 1, to: 3 }] });
		rowDel(b, 2);
		expect(b.rows).toHaveLength(2);
		expect(newRow(emptyBuilder())).toBe(false);
	});
});

describe('plan', () => {
	it('numbers pages continuously from 1, clamping each range to its file', () => {
		const b = two();
		segAdd(b, 1);
		b.rows[1]!.segs[1]!.from = 2;
		b.rows[1]!.segs[1]!.to = 50;
		fromBundle(b, { name: 'N', rows: [...b.rows.map((r) => ({ desc: r.desc, parts: r.segs.map((s) => ({ url: '', name: s.name, from: s.from, to: s.to })) })), { desc: 'MISSING', parts: [{ url: '', name: 'Nope.pdf', from: 1, to: 5 }] }] as never });
		const pl = plan(b);
		expect(pl.pages).toBe(7);
		expect(pl.rows.map((r) => [r.pages, r.from, r.to])).toEqual([[3, 1, 3], [4, 4, 7], [0, 0, 0]]);
		expect(sourcesOf(pl)).toEqual([{ fileId: 'f1', from: 1, to: 3 }, { fileId: 'f2', from: 1, to: 2 }, { fileId: 'f1', from: 2, to: 3 }]);
		expect(unlinked(pl).map((r) => r.row.desc)).toEqual(['MISSING']);
	});
	it('builds the index spec under the page header', () => {
		const b = two();
		b.rows[1]!.desc = '';
		const h = header(headerRaw({ court: 'SYNTHETIC COURT' }, null)).h;
		const s = spec(plan(b), title(' my bundle '), h);
		expect(s.title).toBe('MY BUNDLE');
		expect(s.header.court).toBe('SYNTHETIC COURT');
		expect(s.header.caseNo).toBe('[CASE NUMBER]');
		expect(s.rows).toEqual([{ n: 1, desc: 'ALPHA_STATEMENT', from: 1, to: 3, pages: 3 }, { n: 2, desc: '[DESCRIPTION TO BE COMPLETED]', from: 4, to: 5, pages: 2 }]);
		expect([title(''), pdfName('MY BUNDLE'), indexPdfName('MY BUNDLE'), indexDocxName('MY BUNDLE')]).toEqual(['NEW BUNDLE', 'MY_BUNDLE.pdf', 'Index_MY_BUNDLE.pdf', 'Index_MY_BUNDLE.docx']);
	});
});

const output = (b = two()): Output => ({ id: 'o1', title: 'MY BUNDLE', file: 'MY_BUNDLE.pdf', pages: 6, indexPages: 1, bodyPages: 5, plan: plan(b) });

describe('outputs', () => {
	it('links the Word index only to the output of the same title and item count', () => {
		const b = two(), o = output(b);
		expect(linkable(o, plan(b), 'MY BUNDLE')).toBe(true);
		expect(linkable(o, plan(b), 'OTHER')).toBe(false);
		expect(linkable(null, plan(b), 'MY BUNDLE')).toBe(false);
		expect(docxBundle(plan(b), 'MY BUNDLE', o)).toMatchObject({ file: 'MY_BUNDLE.pdf', indexPages: 1 });
		newRow(b);
		expect(docxBundle(plan(b), 'MY BUNDLE', o)).toMatchObject({ file: '', indexPages: 0 });
	});
	it('stops linking the Word index once an item\'s range is edited after Create (v5 L2352; review of 6778457, M3)', () => {
		const b = two(), o = output(b);
		expect(plan(b).rows.map((r) => [r.from, r.to])).toEqual([[1, 3], [4, 5]]);
		setSeg(b, 0, 0, 'to', 2);
		expect(plan(b).rows.map((r) => [r.from, r.to])).toEqual([[1, 2], [3, 4]]);
		expect(linkable(o, plan(b), 'MY BUNDLE')).toBe(false);
		expect(docxBundle(plan(b), 'MY BUNDLE', o)).toMatchObject({ file: '', indexPages: 0 });
		setSeg(b, 0, 0, 'to', 3);
		expect(linkable(o, plan(b), 'MY BUNDLE')).toBe(true);
		// a different source range with the same size lands on the same bundle pages, so the links stay right
		setSeg(b, 0, 0, 'from', 2);
		setSeg(b, 0, 0, 'to', 3);
		setSeg(b, 0, 0, 'from', 1);
		expect(linkable(o, plan(b), 'MY BUNDLE')).toBe(true);
	});
	it('writes the linked Word index with one external hyperlink per linked cell (v5 cbCell)', () => {
		const b = two(), o = output(b), h = header(headerRaw({}, null)).h;
		const text = (u8: Uint8Array) => new TextDecoder().decode(u8);
		const linked = text(indexDocx([docxBundle(plan(b), 'MY BUNDLE', o)], h, 'c'));
		expect([...linked.matchAll(/Id="(rIdH\d+)"[^>]*Target="([^"]+)" TargetMode="External"/g)].map((m) => [m[1], m[2]])).toEqual([
			['rIdH1', 'MY_BUNDLE.pdf#page=2'], ['rIdH2', 'MY_BUNDLE.pdf#page=2'], ['rIdH3', 'MY_BUNDLE.pdf#page=5'], ['rIdH4', 'MY_BUNDLE.pdf#page=5'],
		]);
		expect(linked).toContain('<w:hyperlink r:id="rIdH2"><w:r><w:rPr><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana" w:cs="Arial"/><w:b/><w:color w:val="0D3399"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">001 – 003</w:t>');
		const plain = text(indexDocx([docxBundle(plan(b), 'OTHER', o)], h, 'c'));
		expect(plain).not.toContain('w:hyperlink');
	});
	it('saves the v5 bundle-list shape and numbers it with the lowest free C<i>', () => {
		const c = savedBundle(output(), nextCustomNo([{ no: 'C1' }, { no: 'C3' }], [{ no: 'C2' }, { no: '1' }]));
		expect(c).toEqual({
			no: 'C4', name: 'MY BUNDLE', pages: 5, indexPages: 1, filePages: 6, note: 'Built in this app. The PDF stays available until this window is closed; the item list is kept.',
			rows: [
				{ n: 1, key: '', desc: 'ALPHA_STATEMENT', pages: 3, from: 1, to: 3, parts: [{ rel: 'Alpha_Statement.pdf', url: '', name: 'Alpha_Statement.pdf', from: 1, to: 3 }] },
				{ n: 2, key: '', desc: 'BETA_LETTER', pages: 2, from: 4, to: 5, parts: [{ rel: 'Beta_Letter.pdf', url: '', name: 'Beta_Letter.pdf', from: 1, to: 2 }] },
			],
		});
		const bundle = toBundle(c);
		expect([bundle.title, bundle.file, bundle.rows[0]!.parts[0]!.url, bundle.rows[1]!.from]).toEqual(['(C4) MY BUNDLE', '', '', 4]);
		expect(toBundle({ ...c, note: '' }).note).toBe('Bundle created in this app.');
	});
});

describe('importV5CustomBundles', () => {
	const v5 = [
		{ no: 'C1', name: 'EXPERTS', pages: 5, indexPages: 1, filePages: 6, note: 'n', rows: [{ n: 1, key: '', desc: 'A', pages: 5, from: 1, to: 5, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 5 }] }] },
		{ no: 'C1', name: 'DUPLICATE' },
		{ name: 'NO NUMBER' },
		null,
		{ no: 2, name: 7, rows: [null, { desc: 'B', parts: 'x' }] },
	];
	it('takes the stored JSON or the parsed array, dropping entries without a number and repeated numbers', () => {
		expect(importV5CustomBundles(JSON.stringify(v5))).toEqual(importV5CustomBundles(v5));
		const out = importV5CustomBundles(v5);
		expect(out.map((c) => c.no)).toEqual(['C1', '2']);
		expect(out[0]).toEqual({ ...v5[0], id: 'v5-C1' });
		expect(out[1]).toEqual({ id: 'v5-2', no: '2', name: '', pages: 0, indexPages: 0, filePages: 0, note: '', rows: [{ n: 1, key: '', desc: 'B', pages: 0, from: 0, to: 0, parts: [] }] });
	});
	it('gives each entry the stable id the (case_id, id) key needs: the same v5 value twice gives the same ids (review of 6778457, M4)', () => {
		const once = importV5CustomBundles(JSON.stringify(v5)), twice = importV5CustomBundles(v5);
		expect(once.map((c) => c.id)).toEqual(twice.map((c) => c.id));
		expect(once.map((c) => c.id)).toEqual(['v5-C1', 'v5-2']);
		const odd = importV5CustomBundles([{ no: 'C 1' }, { no: 'C_1' }, { no: 'C/1' }, { no: 'X'.repeat(200) }, { no: 'Y'.repeat(200) }]);
		expect(new Set(odd.map((c) => c.id)).size).toBe(5);
		for (const c of odd) expect(c.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		expect(importV5CustomBundles([{ no: 'C 1' }])[0]!.id).toBe(odd[0]!.id);
	});
	it('returns nothing for missing or broken data', () => {
		for (const raw of [null, undefined, '', '{', '{}', 42, { no: 'C1' }]) expect(importV5CustomBundles(raw)).toEqual([]);
	});
});
