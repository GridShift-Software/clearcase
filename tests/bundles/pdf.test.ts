// The builder's PDF engine (GRS-19): synthetic PDFs opened, assembled and read back with pdf.js, as the parity harness
// reads them: page count, stamps, index text, link annotations and their targets; encrypted files refused.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makePdf, SET } from './fixtures/make-pdfs.mjs';
import { assemble, clean, EncryptedPdfError, indexOnly, open, pageNos, stampOps, textWidth, visibleBox } from '../../src/lib/bundles/pdf/index.ts';
import type { Doc, IndexSpec } from '../../src/lib/bundles/pdf/index.ts';
import { isDict, isName } from '../../src/lib/bundles/pdf/objects.ts';

const read = async (bytes: Uint8Array) => {
	const pdf = await getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
	const pages: { text: string[]; links: { dest?: unknown; url?: string; unsafeUrl?: string; newWindow?: boolean }[] }[] = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const pg = await pdf.getPage(i);
		const text = (await pg.getTextContent()).items.map((x) => ('str' in x ? x.str : '')).filter((s) => s.trim());
		pages.push({ text, links: (await pg.getAnnotations()).filter((a) => a.subtype === 'Link') });
	}
	const refs = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((p) => p.ref)));
	return { pdf, pages, refs };
};
const docs = async () => {
	const d: Record<string, Doc> = {};
	for (const [f, o] of Object.entries(SET)) if (!o.encrypt) d[f] = await open(makePdf(o));
	return d;
};
const header = { court: 'SYNTHETIC COURT', judge: 'DIVISION', intro: 'In the matter between:', caseNo: '1/2026', claimant: 'A PARTY', claimantRole: 'PLAINTIFF', defendant: 'B PARTY', defendantRole: 'DEFENDANT' };
const spec = (rows: IndexSpec['rows']): IndexSpec => ({ header, title: 'TEST BUNDLE', rows });

describe('open', () => {
	it('reads classic, inherited and object-stream files', async () => {
		const d = await docs();
		expect(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.pages().length]))).toEqual({ 'Alpha_Statement.pdf': 3, 'Beta_Letter.pdf': 2, 'Gamma_Report.pdf': 4 });
	});
	it('refuses an encrypted file with ENCRYPTED', async () => {
		await expect(open(makePdf(SET['Locked.pdf']))).rejects.toBeInstanceOf(EncryptedPdfError);
		await expect(open(makePdf(SET['Locked.pdf']))).rejects.toThrow('ENCRYPTED');
	});
	it('rejects bytes with no readable page', async () => {
		await expect(open(new TextEncoder().encode('not a pdf at all'))).rejects.toThrow('no pages could be read');
	});
});

/** Open `text` (a synthetic PDF) in a child process that is killed after a second: a hang fails the test instead of the run. */
const probe = (text: string) => {
	const dir = mkdtempSync(join(tmpdir(), 'cc-pdf-'));
	try {
		const f = join(dir, 'broken.pdf');
		writeFileSync(f, text, 'latin1');
		const t0 = Date.now();
		const r = spawnSync(process.versions.bun ? process.execPath : 'bun', [join(import.meta.dirname, 'fixtures/open-probe.mjs'), f], { timeout: 1000, encoding: 'utf8' });
		return { ms: Date.now() - t0, timedOut: r.error?.name === 'Error' && /ETIMEDOUT/.test(String(r.error.message)), out: r.stdout.trim() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
const objs = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n';
describe('open: a malformed cross-reference table never hangs (review of 6778457, H1)', () => {
	it('settles a classic table whose subsection claims four billion entries', () => {
		const r = probe(`${objs}xref\n0 4000000000\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${objs.length}\n%%EOF\n`);
		expect(r.timedOut).toBe(false);
		expect(r.ms).toBeLessThan(1000);
		expect(JSON.parse(r.out)).toEqual({ ok: true, pages: 1 });
	});
	it('settles a cross-reference stream whose W sums to 0 with a huge Index', () => {
		const r = probe(`${objs}4 0 obj\n<< /Type /XRef /W [0 0 0] /Index [0 4000000000] /Size 4 /Root 1 0 R /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n${objs.length}\n%%EOF\n`);
		expect(r.timedOut).toBe(false);
		expect(r.ms).toBeLessThan(1000);
		expect(JSON.parse(r.out)).toEqual({ ok: true, pages: 1 });
	});
	it('refuses, with a message, a damaged file that has no page to recover', () => {
		const r = probe(`%PDF-1.4\nxref\n0 4000000000\ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n`);
		expect(r.timedOut).toBe(false);
		expect(JSON.parse(r.out)).toEqual({ ok: false, message: 'no pages could be read from it' });
	});
});

describe('assemble', () => {
	it('puts the index first, stamps the body from 1 and links each row to its first page', async () => {
		const d = await docs();
		const a = await assemble(
			[{ doc: d['Alpha_Statement.pdf']!, from: 2, to: 3 }, { doc: d['Beta_Letter.pdf']!, from: 1, to: 2 }, { doc: d['Gamma_Report.pdf']!, from: 1, to: 4 }],
			{ start: 1, index: spec([{ n: 1, desc: 'ALPHA', from: 1, to: 2 }, { n: 2, desc: 'BETA AND GAMMA', from: 3, to: 8 }]) },
		);
		expect([a.pages, a.indexPages, a.bodyPages]).toEqual([9, 1, 8]);
		const { pages, refs } = await read(a.bytes);
		expect(pages).toHaveLength(9);
		expect(pages[0]!.text).toEqual(expect.arrayContaining(['SYNTHETIC COURT', 'INDEX', 'TEST BUNDLE', 'ALPHA', '001 – 002', 'BETA AND GAMMA', '003 – 008']));
		expect(pages[1]!.text).toEqual(['Synthetic Alpha page 2', '1', '1']);
		expect(pages[3]!.text).toEqual(['Synthetic Beta page 1', '3', '3']);
		expect(pages[8]!.text).toContain('8');
		const dests = pages[0]!.links.map((l) => l.dest as [{ num: number; gen: number }, { name: string }, ...number[]]);
		const targets = dests.map((x) => refs.findIndex((r) => r?.num === x[0].num && r?.gen === x[0].gen) + 1);
		// Each row links on its description and its page numbers (and the row number): all to the item's first page.
		expect(new Set(targets.slice(0, targets.length / 2))).toEqual(new Set([2]));
		expect(new Set(targets.slice(targets.length / 2))).toEqual(new Set([4]));
		expect(dests[0]![1].name).toBe('XYZ');
	});
	it('keeps resources that only a form XObject uses (S-court_bundle_tab-1)', async () => {
		const d = await docs();
		const a = await assemble([{ doc: d['Gamma_Report.pdf']!, from: 1, to: 1 }], { start: 1 });
		const out = await open(a.bytes);
		const pg = out.pages()[0]!;
		const res = out.get(pg.inh.Resources ?? pg.dict.get('Resources'));
		const fonts = isDict(res) ? out.get(res.get('Font')) : null;
		expect(isDict(fonts) && [...fonts.keys()].sort()).toEqual(['F1', 'F2', 'ZaPgNo']);
		expect((await read(a.bytes)).pages[0]!.text).toEqual(['Drawn by a form XObject', 'Synthetic Gamma page 1', '1', '1']);
	});
	it('stamps inside the CropBox and keeps the rotation (S-court_bundle_tab-8)', async () => {
		const d = await docs();
		const beta = d['Beta_Letter.pdf']!;
		expect(visibleBox(beta, beta.pages()[0]!)).toEqual([40, 60, 555, 800]);
		const a = await assemble([{ doc: beta, from: 1, to: 1 }], { start: 7 });
		const out = await open(a.bytes);
		expect(out.get(out.pages()[0]!.dict.get('Rotate'))).toBe(90);
		const { pdf } = await read(a.bytes);
		const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((x) => 'str' in x && x.str === '7');
		expect(items.length).toBe(2);
		for (const it of items) if ('transform' in it) {
			const [, , , , x, y] = it.transform as number[];
			expect(x).toBeGreaterThanOrEqual(40);
			expect(x).toBeLessThanOrEqual(555);
			expect(y).toBeGreaterThanOrEqual(60);
			expect(y).toBeLessThanOrEqual(800);
		}
	});
	it('clamps ranges to the document, copies nothing from an empty range, and reports progress per range', async () => {
		const d = await docs();
		const seen: number[][] = [];
		const a = await assemble([{ doc: d['Alpha_Statement.pdf']!, from: 0, to: 99 }, { doc: d['Beta_Letter.pdf']!, from: 2, to: 1 }], { onProgress: (x, t, p) => void seen.push([x, t, p]) });
		expect([a.pages, a.indexPages, a.bodyPages]).toEqual([3, 0, 3]);
		expect(seen).toEqual([[1, 2, 3], [2, 2, 3]]);
	});
	it('does not log per page (S-court_bundle_tab-14)', async () => {
		const d = await docs();
		(globalThis as Record<string, unknown>).PDFKDBG = true;
		const spy: unknown[] = [];
		const err = console.error;
		console.error = (...a: unknown[]) => void spy.push(a);
		try { await assemble([{ doc: d['Alpha_Statement.pdf']!, from: 1, to: 3 }]); } finally { console.error = err; delete (globalThis as Record<string, unknown>).PDFKDBG; }
		expect(spy).toEqual([]);
	});
});

describe('indexOnly', () => {
	it('links each row into the named bundle file with GoToR, past the index pages', async () => {
		const io = indexOnly(spec([{ n: 1, desc: 'ALPHA', from: 1, to: 3 }, { n: 2, desc: 'BETA', from: 4, to: 4 }]), 'TEST_BUNDLE.pdf');
		expect(io.pages).toBe(1);
		const { pages, pdf } = await read(io.bytes);
		expect(pdf.numPages).toBe(1);
		expect(pages[0]!.text).toEqual(expect.arrayContaining(['ALPHA', '001 – 003', 'BETA', '004']));
		const raw = new TextDecoder('latin1').decode(io.bytes);
		const gotor = [...raw.matchAll(/\/S \/GoToR \/F \(([^)]*)\) \/NewWindow false \/D \[(\d+) \/XYZ 0 841\.89 0\]/g)].map((m) => [m[1], Number(m[2])]);
		expect(new Set(gotor.map((g) => g[0]))).toEqual(new Set(['TEST_BUNDLE.pdf']));
		// D is the 0-based physical page: one index page in front, so body page 1 is page 1 and body page 4 is page 4.
		expect(new Set(gotor.map((g) => g[1]))).toEqual(new Set([1, 4]));
	});
});

describe('index text', () => {
	it('keeps accented letters and curly punctuation (S-court_bundle_tab-6)', () => {
		expect(clean('Müller – “Ñandú” café')).toBe('Müller – “Ñandú” café');
		expect(clean('Łódź')).toBe('Lódz');
		expect(clean('漢字\u0007')).toBe('??');
		expect(textWidth('AB', 10)).toBeCloseTo(14.44);
	});
	it('writes page ranges with an en dash, like the HTML and Word indexes (S-court_bundle_tab-7)', () => {
		expect(pageNos({ from: 5, to: 7 })).toBe('005 – 007');
		expect(pageNos({ from: 5, to: 5 })).toBe('005');
		expect(pageNos({ from: 0, to: 0 })).toBe('');
	});
	it('reads accented text back from the PDF index', async () => {
		const io = indexOnly(spec([{ n: 1, desc: 'RAPPORT DE L’EXPERT – ÉTÉ', from: 1, to: 2 }]), 'x.pdf');
		expect((await read(io.bytes)).pages[0]!.text).toContain('RAPPORT DE L’EXPERT – ÉTÉ');
	});
	it('draws stamps white-outlined then black', () => {
		const ops = stampOps('12', [0, 0, 595, 842], 0);
		expect(ops.match(/\(12\) Tj/g)).toHaveLength(2);
		expect(ops).toContain('1 1 1 rg');
		expect(isName(null)).toBe(false);
	});
});
