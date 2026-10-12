// Court Bundle (v5 court_bundle_tab, L1837-2580): the index rules shared by the page, its Word export and the tests.
// The bundles are imported data (`bundles`) followed by the bundles saved from the builder (user work, `id` set); the
// index header is user work over the imported header defaults. The builder itself is in $lib/bundles.

export interface Part { url: string; name: string; from: number; to: number }
export interface BundleRow { n: number | string; key: string; desc: string; date: string; blank: boolean; missing: boolean; review: boolean; pages: number; from: number; to: number; sliceUrl: string; caselines: { stamps: string; from: number } | null; parts: Part[] }
export interface Bundle { no: string; name: string; title: string; note: string; rows: BundleRow[]; pages: number; indexPages: number; file: string; indexFile: string; /** a bundle saved from the builder: its output id */ id?: string }

export const HEADER_KEYS = ['court', 'judge', 'intro', 'caseNo', 'claimant', 'claimantRole', 'defendant', 'defendantRole'] as const;
export type HeaderKey = (typeof HEADER_KEYS)[number];
export type Header = Record<HeaderKey, string>;
/** v5 CBHF (L1862): label, generic placeholder, multi-line. Case examples come from view-content. */
export const HEADER_FIELDS: readonly { key: HeaderKey; label: string; placeholder: string; ml?: true; example?: 'headerCourtExample' | 'headerDivisionExample' | 'headerCaseNumberExample' }[] = [
	{ key: 'court', label: 'Court line', placeholder: '', example: 'headerCourtExample' },
	{ key: 'judge', label: 'Division / presiding officer line', placeholder: '', example: 'headerDivisionExample' },
	{ key: 'intro', label: 'Introductory line', placeholder: 'In the matter between:' },
	{ key: 'caseNo', label: 'Case number', placeholder: '', example: 'headerCaseNumberExample' },
	{ key: 'claimant', label: 'Plaintiff / claimant citation', placeholder: 'Full party name — one line per line', ml: true },
	{ key: 'claimantRole', label: 'Plaintiff label', placeholder: 'PLAINTIFF' },
	{ key: 'defendant', label: 'Defendant / respondent citation', placeholder: 'Full party name — one line per line', ml: true },
	{ key: 'defendantRole', label: 'Defendant label', placeholder: 'DEFENDANT' },
];
/** v5 CBPH (L1856): the placeholders printed for a blank field. */
export const PLACEHOLDER: Header = { court: '[COURT / FORUM]', judge: '[DIVISION / PRESIDING OFFICER]', intro: 'In the matter between:', claimant: '[PLAINTIFF NAME]', claimantRole: 'PLAINTIFF', defendant: '[DEFENDANT NAME]', defendantRole: 'DEFENDANT', caseNo: '[CASE NUMBER]' };

/** v5 cbHdrRaw (L1872): the imported defaults overlaid with the stored header (a stored '' blanks a default). */
export function headerRaw(defaults: Partial<Record<string, unknown>>, stored: Partial<Record<string, unknown>> | null): Header {
	const out = {} as Header;
	for (const k of HEADER_KEYS) { const s = stored && Object.hasOwn(stored, k) ? stored[k] : defaults[k]; out[k] = typeof s === 'string' ? s : ''; }
	return out;
}
/** v5 cbHdr (L1873): each value trimmed, else its placeholder; and the blank keys. */
export function header(raw: Header): { h: Header; blank: HeaderKey[] } {
	const h = {} as Header;
	for (const k of HEADER_KEYS) h[k] = raw[k].trim() || PLACEHOLDER[k];
	return { h, blank: HEADER_KEYS.filter((k) => !raw[k].trim()) };
}

/** v5 cbPad (L1909). */
export const pad = (n: unknown) => { let s = String(n || 0); while (s.length < 3) s = '0' + s; return s; };
/** v5 cbRange (L1910): en dash between padded numbers. */
export const range = (r: Pick<BundleRow, 'pages' | 'from' | 'to'>) => (!r.pages || !r.from ? '' : r.from === r.to ? pad(r.from) : `${pad(r.from)} – ${pad(r.to)}`);
export const TO_COMPLETE = '[DESCRIPTION TO BE COMPLETED]';
/** v5 cbDesc (L1912): the description (or the to-be-completed marker) with its date unless it already ends with it, upper-cased. */
export function desc(r: Pick<BundleRow, 'desc' | 'date'>): string {
	const d = String(r.desc || '').trim() || TO_COMPLETE;
	const dt = r.date ? String(r.date).trim() : '';
	const nz = (t: string) => t.replace(/\s+/g, '').toUpperCase();
	const dup = dt && nz(d).endsWith(nz(dt));
	return (d + (dt && !dup ? ' – ' + dt : '')).toUpperCase();
}
/** v5 cbTot (L1931): items, pages, rows to review (not blank and missing or without pages), blank rows. */
export const totals = (b: Bundle) => ({ items: b.rows.length, pages: b.pages || 0, missing: b.rows.filter((r) => !r.blank && (r.missing || !r.pages)).length, blank: b.rows.filter((r) => r.blank).length });
/** v5 cbSlug (L2569). */
export const slug = (s: string) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
/** v5 cleanName (L439). */
export const cleanName = (f: string) => String(f || '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');
export const indexFileName = (b: Pick<Bundle, 'no' | 'name'>) => `Index_${slug(b.no + '_' + b.name)}.docx`;
/** "pp a–b of source" (v5 L2027). */
export const partRange = (p: Part) => (p.from === p.to ? `p ${p.from}` : `pp ${p.from}–${p.to}`) + ' of source';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** v5 cbBundles (L1897), shipped bundles only, from untrusted data. */
export function bundlesOf(data: unknown): Bundle[] {
	const list = (data as { list?: unknown } | null)?.list;
	return (Array.isArray(list) ? list : []).filter((b) => b && typeof b === 'object').map((b: Record<string, unknown>) => ({
		no: String(b.no ?? ''), name: str(b.name), title: str(b.title) || `(${String(b.no ?? '')}) ${str(b.name)}`, note: str(b.note),
		pages: num(b.pages), indexPages: num(b.indexPages), file: str(b.file), indexFile: str(b.indexFile),
		rows: (Array.isArray(b.rows) ? b.rows : []).filter((r) => r && typeof r === 'object').map((r: Record<string, unknown>) => {
			const cl = r.caselines as Record<string, unknown> | undefined;
			return {
				n: typeof r.n === 'number' || typeof r.n === 'string' ? r.n : '', key: str(r.key), desc: str(r.desc), date: str(r.date), blank: r.blank === true, missing: r.missing === true, review: r.review === true,
				pages: num(r.pages), from: num(r.from), to: num(r.to), sliceUrl: str(r.sliceUrl), caselines: cl && typeof cl === 'object' ? { stamps: str(cl.stamps), from: num(cl.from) } : null,
				parts: (Array.isArray(r.parts) ? r.parts : []).filter((p) => p && typeof p === 'object').map((p: Record<string, unknown>) => ({ url: str(p.url), name: str(p.name), from: num(p.from), to: num(p.to) })),
			};
		}),
	}));
}
