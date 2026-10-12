// Discovery Schedule rules (v5 discovery_tab) on synthetic schedules: filter, unmatched, selection order, the cover
// page's C/O (S-discovery_tab-2), escaping (S-discovery_tab-4), incomplete exports (BA-10) and link resolution.
import { describe, expect, it } from 'vitest';
import { bundleHTML, coverCo, coverDoc, fileCo, filterItems, incompleteNotes, scheduleCounts, selectedFiles, type Caption, type CO, type ScheduleFile, type ScheduleItem } from '../../src/lib/views/bundles/discovery';
import { NOT_SERVED, fragmentPage, pathIndex, resolveLocator } from '../../src/lib/views/bundles/links';

const file = (fn: string, ref: string | null = 'SYN-1', co = 'C'): ScheduleFile => ({ fn, url: `./Folder/${encodeURIComponent(fn)}`, co, x: null, key: `Folder/${fn}`, ref });
const item = (no: number, desc: string, files: ScheduleFile[], co = 'C', date = ''): ScheduleItem => ({ no, desc, date, co, nfiles: files.length, files });
const disc = [item(3, 'Letter of demand', [file('b.pdf'), file('a.pdf')], 'C', '01/02/2001'), item(10, 'Invoice batch', [file('inv.pdf', null)]), item(12, 'Missing record', []), item(21, ' ', [])];
const supp = [item(1, 'Supplementary note', [file('s.pdf')], '')];
const S = { discovery: disc, supplementary: supp };
const cap: Caption = { court: 'SYNTHETIC COURT', division: '(DIVISION)', caseNumber: 'CASE NUMBER: 1/2', plaintiff: 'A & B <PTY>', plaintiffCitation: 'A & B\nline two', plaintiffRole: 'PLAINTIFF', defendant: 'C "D"', defendantCitation: 'C', defendantRole: 'DEFENDANT', bundleIndexName: 'Synthetic Index' };

describe('discovery schedule rules', () => {
	it('filters like v5 rowsFor: item number as substring, description, date, file name; only unmatched', () => {
		expect(filterItems(disc, '1', false).map((i) => i.no)).toEqual([3, 10, 12, 21]);
		expect(filterItems(disc, 'INV', false).map((i) => i.no)).toEqual([10]);
		expect(filterItems(disc, 'a.pdf', false).map((i) => i.no)).toEqual([3]);
		expect(filterItems(disc, '  ', false)).toHaveLength(4);
		expect(filterItems(disc, '', true).map((i) => i.no)).toEqual([12]);
	});
	it('derives counts from the schedule (BA-10)', () => {
		expect(scheduleCounts(disc)).toEqual({ items: 4, files: 3, declared: 3, unmatched: 1, notServed: 1 });
	});
	it('orders selected files by schedule, item number, then file name (v5 selectedFiles)', () => {
		const sel = new Set(['Folder/s.pdf', 'Folder/b.pdf', 'Folder/a.pdf', 'Folder/inv.pdf']);
		const out = selectedFiles(S, sel, new Map());
		expect(out.map((f) => `${f.schedule}:${f.no}:${f.fn}`)).toEqual(['discovery:3:a.pdf', 'discovery:3:b.pdf', 'discovery:10:inv.pdf', 'supplementary:1:s.pdf']);
	});
	it('fileCo: the mark, else the file co, else C', () => {
		expect(fileCo(file('x', null, ''), new Map())).toBe('C');
		expect(fileCo(file('x', null, 'O'), new Map())).toBe('O');
		expect(fileCo(file('x'), new Map<string, CO>([['Folder/x', 'O']]))).toBe('O');
	});
	it('cover C/O follows the marks per item: all C, all O, mixed C&O; without marks the data value (S-discovery_tab-2)', () => {
		const i = disc[0]!;
		expect(coverCo(i, new Map())).toBe('C');
		expect(coverCo(supp[0]!, new Map())).toBe('');
		expect(coverCo(i, new Map<string, CO>([['Folder/a.pdf', 'O'], ['Folder/b.pdf', 'O']]))).toBe('O');
		expect(coverCo(i, new Map<string, CO>([['Folder/a.pdf', 'O']]))).toBe('C&O');
		expect(coverCo(supp[0]!, new Map<string, CO>([['Folder/s.pdf', 'C']]))).toBe('C');
	});
	it('the cover page escapes every value, marks items without a document, and keeps v5 wording', () => {
		const html = coverDoc(cap, { deed: "PLAINTIFF'S <DEED>", schedule: 'FIRST SCHEDULE', file: 'Cover & file', label: null }, disc, new Map<string, CO>([['Folder/a.pdf', 'O']]));
		expect(html).toContain('<title>Cover &amp; file</title>');
		expect(html).toContain('<span>A &amp; B\nline two</span>');
		expect(html).toContain("PLAINTIFF'S &lt;DEED&gt;");
		expect(html).toContain('<td class="co">C&amp;O</td>');
		expect(html).toContain('Missing record [No separate document on file — see coverage note]');
		expect(html).not.toContain('<DEED>');
		expect(html).toContain('Certified a true copy');
	});
	it('the bundle index says when the selection is incomplete, and marks files not served (BA-10)', () => {
		const sel = new Set(['Folder/b.pdf', 'Folder/inv.pdf']);
		const files = selectedFiles(S, sel, new Map());
		const notes = incompleteNotes(files, sel);
		expect(notes).toEqual(['1 of 2 selected documents are not in the verified index and not served', '1 item is only partly selected']);
		const html = bundleHTML(cap, files, notes);
		expect(html).toContain('<b>INCOMPLETE SELECTION</b>: ');
		expect(html).toContain(`inv.pdf [${NOT_SERVED.toUpperCase()}]`);
		expect(html).toContain('<h2>A &amp; B &lt;PTY&gt; v C &quot;D&quot;</h2>');
		const full = new Set(['Folder/a.pdf', 'Folder/b.pdf']);
		expect(incompleteNotes(selectedFiles(S, full, new Map()), full)).toEqual([]);
		expect(bundleHTML(cap, selectedFiles(S, full, new Map()), [])).not.toContain('INCOMPLETE');
	});
});

describe('bundle link resolution', () => {
	const idx = pathIndex([
		{ ref: 'SYN-2', ord: 2, originalPath: 'Folder/a.pdf', url: null },
		{ ref: 'SYN-1', ord: 1, originalPath: 'Folder/a.pdf', url: null },
		{ ref: 'SYN-3', ord: 3, originalPath: null, url: './Other/c%20d.pdf' },
		{ ref: 'SYN-4', ord: 4, originalPath: null, url: '../escape.pdf' },
	]);
	it('takes the lowest ord for a shared path and a decodable row locator when no original is indexed', () => {
		expect(idx.get('Folder/a.pdf')).toBe('SYN-1');
		expect(idx.get('Other/c d.pdf')).toBe('SYN-3');
		expect(idx.size).toBe(2);
	});
	it('resolves only an exact indexed path, with the page fragment; never fuzzy, never an item key', () => {
		expect(resolveLocator(idx, './Folder/a.pdf#page=7')).toEqual({ ref: 'SYN-1', page: 7 });
		expect(resolveLocator(idx, './Folder/A.pdf')).toBeNull();
		expect(resolveLocator(idx, './Folder/a.pdf ')).toBeNull();
		expect(resolveLocator(idx, 'OD-10')).toBeNull();
		expect(resolveLocator(idx, './Folder/')).toBeNull();
		expect(resolveLocator(idx, './%2e%2e/x.pdf')).toBeNull();
		expect(fragmentPage('./x.pdf#page=0')).toBeNull();
		expect(fragmentPage('./x.pdf#search=x')).toBeNull();
	});
});
