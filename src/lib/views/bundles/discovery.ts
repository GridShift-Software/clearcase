import { attr } from './download.ts';

export type Mode = 'discovery' | 'supplementary';
export const MODES: readonly Mode[] = ['discovery', 'supplementary'];
export type CO = 'C' | 'O';

export interface ScheduleFile {
	fn: string; url: string; co: string; x: string | null;
	key: string;
	ref: string | null;
}
export interface ScheduleItem { no: number; date: string; co: string; desc: string; nfiles: number; files: ScheduleFile[] }

export interface Caption {
	court: string | null; division: string | null; caseNumber: string | null;
	plaintiff: string | null; plaintiffCitation: string | null; plaintiffRole: string | null;
	defendant: string | null; defendantCitation: string | null; defendantRole: string | null;
	bundleIndexName: string | null;
}
export interface ModeMeta { deed: string | null; schedule: string | null; file: string | null; label: string | null }

export const isUnmatched = (i: ScheduleItem) => i.files.length === 0 && i.desc.trim() !== '';

export function scheduleCounts(items: readonly ScheduleItem[]) {
	let files = 0, notServed = 0, declared = 0;
	for (const i of items) { files += i.files.length; declared += i.nfiles; for (const f of i.files) if (!f.ref) notServed++; }
	return { items: items.length, files, declared, unmatched: items.filter(isUnmatched).length, notServed };
}

export function filterItems(items: readonly ScheduleItem[], q: string, onlyMissing: boolean): ScheduleItem[] {
	let out = onlyMissing ? items.filter(isUnmatched) : [...items];
	const s = q.trim().toLowerCase();
	if (s) out = out.filter((i) => String(i.no).includes(s) || (i.desc || '').toLowerCase().includes(s) || (i.date || '').toLowerCase().includes(s) || i.files.some((f) => f.fn.toLowerCase().includes(s)));
	return out;
}

export const fileCo = (f: ScheduleFile, marks: ReadonlyMap<string, CO>): string => marks.get(f.key) || f.co || 'C';

export interface SelectedFile { schedule: Mode; no: number; desc: string; date: string; fn: string; key: string; ref: string | null; co: string; item: ScheduleItem }

export function selectedFiles(s: Record<Mode, readonly ScheduleItem[]>, sel: ReadonlySet<string>, marks: ReadonlyMap<string, CO>): SelectedFile[] {
	const out: SelectedFile[] = [];
	for (const schedule of MODES) for (const i of s[schedule]) for (const f of i.files) if (sel.has(f.key)) out.push({ schedule, no: i.no, desc: i.desc, date: i.date, fn: f.fn, key: f.key, ref: f.ref, co: fileCo(f, marks), item: i });
	const ord = { discovery: 0, supplementary: 1 };
	return out.sort((a, b) => ord[a.schedule] - ord[b.schedule] || a.no - b.no || a.fn.localeCompare(b.fn));
}

export function coverCo(i: ScheduleItem, marks: ReadonlyMap<string, CO>): string {
	if (!i.files.some((f) => marks.has(f.key))) return i.co || '';
	const set = new Set(i.files.map((f) => marks.get(f.key) || f.co || i.co || 'C'));
	return set.size > 1 ? 'C&O' : [...set][0]!;
}

export const NO_DOCUMENT = 'No separate document on file — see coverage note';

/** The certified cover page of the current schedule (v5 coverDoc L3456): v5's markup, every value escaped. */
export function coverDoc(c: Caption, m: ModeMeta, items: readonly ScheduleItem[], marks: ReadonlyMap<string, CO>): string {
	const rows = items.map((i) => '<tr><td class="n">' + attr(i.no) + '.</td><td>' + attr(i.desc || '') + (isUnmatched(i) ? ' [' + attr(NO_DOCUMENT) + ']' : '') + '</td><td class="d">' + attr(i.date || '') + '</td><td class="co">' + attr(coverCo(i, marks)) + '</td></tr>').join('');
	return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + attr(m.file ?? '') + '</title>'
		+ '<style>@page{margin:18mm}body{font-family:Georgia,"Times New Roman",serif;color:#000;margin:0}'
		+ '.hd{text-align:center;margin-bottom:14px}.hd .c{font-weight:700}.hd .u{text-decoration:underline}'
		+ '.par{font-size:12px;margin:2px 0}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}'
		+ 'th,td{border:1px solid #000;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee}'
		+ '.n{width:42px;text-align:center}.d{width:130px}.co{width:52px;text-align:center}'
		+ '.cn{text-align:right}.lft{text-align:left}'
		+ '.pt{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;text-align:left;font-weight:700;font-size:12px;margin:6px 0}'
		+ '.pt span:first-child{white-space:pre-line}.pt span:last-child{white-space:nowrap}'
		+ 'h3{text-align:center;text-decoration:underline;margin:14px 0 4px}'
		+ '.foot{margin-top:26px;font-size:12px}.sig{margin-top:34px}.line{border-top:1px solid #000;width:280px;padding-top:3px}</style></head><body>'
		+ '<div class="hd"><div class="c">' + attr(c.court ?? '') + '</div><div class="c">' + attr(c.division ?? '') + '</div><br>'
		+ '<div class="par cn">' + attr(c.caseNumber ?? '') + '</div><br><div class="par lft">In the matter between:</div><br>'
		+ '<div class="pt"><span>' + attr(c.plaintiffCitation ?? '') + '</span><span>' + attr(c.plaintiffRole ?? '') + '</span></div>'
		+ '<div class="par lft">and</div>'
		+ '<div class="pt"><span>' + attr(c.defendantCitation ?? '') + '</span><span>' + attr(c.defendantRole ?? '') + '</span></div><br>'
		+ '<div class="c u">' + attr(m.deed ?? '') + '</div></div>'
		+ '<h3>' + attr(m.schedule ?? '') + '</h3>'
		+ '<table><thead><tr><th class="n">No.</th><th>Document</th><th class="d">Date</th><th class="co">C/O</th></tr></thead>'
		+ '<tbody>' + rows + '</tbody></table>'
		+ '<div class="foot">C = Copy &nbsp;&middot;&nbsp; O = Original &nbsp;&middot;&nbsp; C&amp;O = Copy and Original.</div>'
		+ '<div class="sig"><div class="line">Certified a true copy</div></div>'
		+ '<div class="sig"><div class="line">COMMISSIONER OF OATHS</div></div>'
		+ '</body></html>';
}

export const schedLabel = (k: Mode) => (k === 'discovery' ? 'Discovery Affidavit — First Schedule' : 'Supplementary — First Schedule A');

export function incompleteNotes(files: readonly SelectedFile[], sel: ReadonlySet<string>): string[] {
	const out: string[] = [];
	const notServed = files.filter((f) => !f.ref).length;
	if (notServed) out.push(`${notServed} of ${files.length} selected document${files.length === 1 ? ' is' : 's are'} not in the verified index and not served`);
	const partial = new Set(files.filter((f) => f.item.files.some((g) => !sel.has(g.key))).map((f) => `${f.schedule}-${f.no}`)).size;
	if (partial) out.push(`${partial} item${partial === 1 ? ' is' : 's are'} only partly selected`);
	return out;
}

function bundleRows(files: readonly SelectedFile[], escape: boolean): string {
	const e = (s: unknown) => (escape ? attr(s) : String(s ?? ''));
	let last: Mode | null = null, rows = '';
	files.forEach((f, idx) => {
		if (f.schedule !== last) { last = f.schedule; rows += '<tr class="sec"><td colspan="6">' + attr(schedLabel(f.schedule)) + '</td></tr>'; }
		rows += '<tr><td class="n">' + (idx + 1) + '</td><td class="n">' + e(f.no) + '.</td><td>' + attr(f.desc) + '</td>'
			+ '<td class="d">' + attr(f.date || '') + '</td><td>' + attr(f.fn) + (f.ref ? '' : ' [' + NOT_SERVED_UPPER + ']') + '</td><td class="co">' + e(f.co) + '</td></tr>';
	});
	return rows;
}
const NOT_SERVED_UPPER = 'NOT IN THE VERIFIED INDEX; NOT SERVED';

const incompleteLine = (notes: readonly string[]) => (notes.length ? '<div class="cap"><b>INCOMPLETE SELECTION</b>: ' + notes.map(attr).join('; ') + '.</div>' : '');

export function bundleHTML(c: Caption, files: readonly SelectedFile[], notes: readonly string[]): string {
	return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + attr(c.bundleIndexName ?? '') + '</title>'
		+ '<style>body{font-family:Georgia,serif;color:#000;margin:28px}h2{text-align:center;margin:0}'
		+ '.cap{text-align:center;font-size:13px;margin:2px 0 16px}table{width:100%;border-collapse:collapse;font-size:12px}'
		+ 'th,td{border:1px solid #000;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee}'
		+ '.n{width:40px;text-align:center}.d{width:130px}.co{width:46px;text-align:center}'
		+ '.sec td{background:#f0f0f0;font-weight:700;text-transform:uppercase;font-size:11px}</style></head><body>'
		+ '<h2>' + attr(c.plaintiff ?? '') + ' v ' + attr(c.defendant ?? '') + '</h2>'
		+ '<div class="cap">' + attr(c.court ?? '') + ' ' + attr(c.division ?? '') + ' · ' + attr(c.caseNumber ?? '') + '<br><b>COURT BUNDLE — INDEX OF DOCUMENTS</b> (' + files.length + ' documents)</div>'
		+ incompleteLine(notes)
		+ '<table><thead><tr><th class="n">#</th><th class="n">Item</th><th>Description</th><th class="d">Date</th><th>Document</th><th class="co">C/O</th></tr></thead>'
		+ '<tbody>' + bundleRows(files, true) + '</tbody></table></body></html>';
}

export function printHTML(c: Caption, files: readonly SelectedFile[], notes: readonly string[]): string {
	return '<h2>' + attr(c.plaintiff ?? '') + ' v ' + attr(c.defendant ?? '') + '</h2>'
		+ '<div class="cap">' + attr(c.court ?? '') + ' ' + attr(c.division ?? '') + ' &middot; ' + attr(c.caseNumber ?? '') + '<br><b>COURT BUNDLE — INDEX OF DOCUMENTS</b> (' + files.length + ' documents)</div>'
		+ incompleteLine(notes)
		+ '<table><thead><tr><th class="n">#</th><th class="n">Item</th><th>Description</th><th class="d">Date</th><th>Document</th><th class="co">C/O</th></tr></thead>'
		+ '<tbody>' + bundleRows(files, true) + '</tbody></table>';
}
