// D16: the Word index links each row as v5 cbDocHref does (synthetic data). The targets are relative file paths Word
// resolves next to the saved index; a value that is not a relative path inside the case folder is never linked.
import { describe, expect, it } from 'vitest';
import { unzip } from '../../scripts/parity/lib/exports.mjs';
import { bundlesOf, header, headerRaw } from '../../src/lib/views/bundles/court';
import { docHref, indexDocx } from '../../src/lib/views/bundles/docx';

type Raw = Record<string, unknown>;
const bundle = (b: Raw, rows: Raw[]) => bundlesOf({ list: [{ no: '1', name: 'Synthetic', title: 'Synthetic bundle', ...b, rows }] })[0]!;
const row = (r: Raw): Raw => ({ n: 1, desc: 'Synthetic row', date: '', pages: 3, from: 4, to: 6, ...r });
const href = (b: Raw, r: Raw) => { const x = bundle(b, [row(r)]); return docHref(x, x.rows[0]!); };
const rels = (bytes: Uint8Array) => [...new TextDecoder().decode(unzip(bytes).get('word/_rels/document.xml.rels')!).matchAll(/Id="(rIdH\d+)"[^>]*Target="([^"]*)" TargetMode="External"/g)].map((m) => [m[1], m[2]]);

describe('D16: Word index hyperlinks (v5 cbDocHref)', () => {
	it('links into the bundle PDF at the physical page (index pages in front), dropping the leading ./', () => {
		expect(href({ file: './Court%20Bundle/Synthetic_Bundle.pdf', indexPages: 2 }, { sliceUrl: './Court%20Bundle/x.pdf' })).toBe('Court%20Bundle/Synthetic_Bundle.pdf#page=6');
	});
	it('falls back to the extract, then to the first source part (at its page past 1)', () => {
		expect(href({}, { sliceUrl: './Extracts/Item_1.pdf', parts: [{ url: './A.pdf', name: 'A.pdf', from: 3, to: 4 }] })).toBe('Extracts/Item_1.pdf');
		expect(href({}, { parts: [{ url: './Docs/A.pdf', name: 'A.pdf', from: 3, to: 4 }, { url: './B.pdf', name: 'B.pdf', from: 1, to: 1 }] })).toBe('Docs/A.pdf#page=3');
		expect(href({}, { parts: [{ url: './Docs/A.pdf', name: 'A.pdf', from: 1, to: 2 }] })).toBe('Docs/A.pdf');
		expect(href({ file: './B.pdf' }, { from: 0 })).toBe('');
	});
	it('never links a scheme, an absolute path, a ".." path, a folder or an empty locator', () => {
		for (const u of ['javascript:alert(1)', 'https://example.invalid/x.pdf', 'file:///etc/passwd', 'C:/x.pdf', '/etc/x.pdf', '../x.pdf', './a/../../x.pdf', './a/%2e%2e/x.pdf', './Folder/', '\\\\host\\x.pdf', ''])
			expect([u, href({}, { sliceUrl: u })]).toEqual([u, '']);
		expect(href({}, { parts: [{ url: '', name: 'A.pdf', from: 3, to: 3 }] })).toBe('');
	});
	it('writes one external relationship per non-empty linked cell for shipped bundles, and none for an unsafe row', () => {
		const b = bundle({ file: './Synthetic_Bundle.pdf', indexPages: 1 }, [row({ n: 1, from: 1, to: 2 }), row({ n: 2, from: 0, to: 0, sliceUrl: 'javascript:alert(1)' }), row({ n: 3, from: 0, to: 0, sliceUrl: './Extracts/Item_3.pdf' })]);
		const bytes = indexDocx([b], header(headerRaw({}, null)).h, 'c');
		expect(rels(bytes)).toEqual([['rIdH1', 'Synthetic_Bundle.pdf#page=2'], ['rIdH2', 'Synthetic_Bundle.pdf#page=2'], ['rIdH3', 'Extracts/Item_3.pdf']]); // row 3 has no page range, so only its description links
		expect(new TextDecoder().decode(unzip(bytes).get('word/document.xml')!)).not.toContain('javascript');
	});
});
