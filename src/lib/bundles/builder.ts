/**
 * The Court Bundle builder's rules (v5 CBBLD, main HTML 2120-2382), kept pure so the page, the tests and the parity
 * sweep share them: picked files, items made of page ranges, the running page plan, the index spec, and the saved
 * bundle-list entry. The PDF bytes and parsed documents stay in the page's session state, keyed by file id.
 */
import { cleanName, desc, slug, type Bundle, type BundleRow, type Header } from '../views/bundles/court.ts';
import type { IndexSpec } from './pdf/index.ts';

export interface BFile { id: string; name: string; size: number; pages: number }
/** One range of one source; `fileId` null until a file with the matching name is added. */
export interface Seg { fileId: string | null; name: string; from: number; to: number }
export interface BRow { desc: string; segs: Seg[] }
export interface Builder { files: BFile[]; rows: BRow[]; name: string; seq: number }

export const emptyBuilder = (): Builder => ({ files: [], rows: [], name: '', seq: 1 });
export const fileOf = (b: Builder, id: string | null) => (id === null ? null : (b.files.find((f) => f.id === id) ?? null));

/** v5 cbBldLink: a file just added attaches to segments pre-filled from a bundle, by lower-cased file name. */
export function linkFile(b: Builder, f: BFile): void {
	const base = f.name.toLowerCase();
	for (const r of b.rows)
		for (const s of r.segs)
			if (!s.fileId && String(s.name || '').toLowerCase() === base) {
				s.fileId = f.id;
				if (s.to > f.pages) s.to = f.pages;
				if (s.from > f.pages) s.from = f.pages;
			}
}

/** v5 cbBldAdd for one read file: skipped (null) when a file of the same name and size is already in; otherwise linked,
 * and given its own item when no segment uses it yet. */
export function addFile(b: Builder, name: string, size: number, pages: number): BFile | null {
	if (b.files.some((x) => x.name === name && x.size === size)) return null;
	const f: BFile = { id: 'f' + b.seq++, name, size, pages };
	b.files.push(f);
	linkFile(b, f);
	if (!b.rows.some((r) => r.segs.some((s) => s.fileId === f.id)))
		b.rows.push({ desc: cleanName(name).toUpperCase(), segs: [{ fileId: f.id, name, from: 1, to: pages }] });
	return f;
}

/** v5 cbBldSetSeg: a whole number, at least 1, at most the file's pages; `to` never below `from`. */
export function setSeg(b: Builder, i: number, j: number, k: 'from' | 'to', v: unknown): void {
	const s = b.rows[i]?.segs[j];
	if (!s) return;
	const max = fileOf(b, s.fileId)?.pages ?? 99999;
	let n = parseInt(String(v), 10);
	if (!(n > 0)) n = 1;
	if (n > max) n = max;
	s[k] = n;
	if (s.to < s.from) s.to = s.from;
}
/** v5 cbBldSegDel: an item left with no range goes. */
export function segDel(b: Builder, i: number, j: number): void {
	const r = b.rows[i];
	if (!r) return;
	r.segs.splice(j, 1);
	if (!r.segs.length) b.rows.splice(i, 1);
}
export function segAdd(b: Builder, i: number): void {
	const r = b.rows[i], f = b.files[0];
	if (r && f) r.segs.push({ fileId: f.id, name: f.name, from: 1, to: f.pages });
}
export function segFile(b: Builder, i: number, j: number, id: string): void {
	const s = b.rows[i]?.segs[j], f = fileOf(b, id);
	if (!s || !f) return;
	Object.assign(s, { fileId: f.id, name: f.name, from: 1, to: f.pages });
}
/** v5 cbBldNewRow: false when no PDF is in yet ('Add at least one PDF first.'). */
export function newRow(b: Builder): boolean {
	const f = b.files[0];
	if (!f) return false;
	b.rows.push({ desc: '', segs: [{ fileId: f.id, name: f.name, from: 1, to: f.pages }] });
	return true;
}
export function rowMove(b: Builder, i: number, d: number): void {
	const j = i + d;
	if (j < 0 || j >= b.rows.length || !b.rows[i]) return;
	[b.rows[i], b.rows[j]] = [b.rows[j]!, b.rows[i]!];
}
export const rowDel = (b: Builder, i: number) => void b.rows.splice(i, 1);

/** v5 cbBldFrom: the items of a defined bundle, each part waiting for the file of its name. */
export function fromBundle(b: Builder, src: Pick<Bundle, 'name' | 'rows'>): void {
	b.rows = src.rows
		.map((r) => ({ desc: r.desc || '', segs: r.parts.map((p) => ({ fileId: null, name: p.name, from: p.from || 1, to: p.to || 1 })) }))
		.filter((r) => r.segs.length);
	b.name = src.name;
	for (const f of b.files) linkFile(b, f);
}

export interface PlanSeg { seg: Seg; file: BFile | null; from: number; to: number; n: number }
export interface PlanRow { i: number; row: BRow; segs: PlanSeg[]; pages: number; from: number; to: number }
export interface Plan { rows: PlanRow[]; pages: number }
/** v5 cbBldPlan: ranges clamped to their files, pages numbered continuously from 1 exactly as the assembler stamps them. */
export function plan(b: Builder): Plan {
	const rows: PlanRow[] = [];
	let p = 1;
	b.rows.forEach((row, i) => {
		let n = 0;
		const segs: PlanSeg[] = row.segs.map((seg) => {
			const file = fileOf(b, seg.fileId);
			if (!file) return { seg, file: null, from: 0, to: 0, n: 0 };
			const a = Math.max(1, Math.min(seg.from, file.pages)), z = Math.max(a, Math.min(seg.to, file.pages));
			n += z - a + 1;
			return { seg, file, from: a, to: z, n: z - a + 1 };
		});
		rows.push({ i, row, segs, pages: n, from: n ? p : 0, to: n ? p + n - 1 : 0 });
		p += n;
	});
	return { rows, pages: p - 1 };
}
/** Items with a range whose file is not added (skipped on Create, after a confirm). */
export const unlinked = (pl: Plan) => pl.rows.filter((r) => r.segs.some((s) => !s.file));
/** The (file, range) list the assembler copies, in order. */
export const sourcesOf = (pl: Plan) => pl.rows.flatMap((r) => r.segs.filter((s) => s.file).map((s) => ({ fileId: s.file!.id, from: s.from, to: s.to })));

/** v5 cbBldTitle. */
export const title = (name: string) => (name || 'NEW BUNDLE').trim().toUpperCase();
export const pdfName = (t: string) => slug(t) + '.pdf';
export const indexPdfName = (t: string) => 'Index_' + slug(t) + '.pdf';
export const indexDocxName = (t: string) => 'Index_' + slug(t) + '.docx';

/** v5 cbBldSpec: the PDF index under the page's header. */
export function spec(pl: Plan, t: string, h: Header): IndexSpec {
	return { header: { ...h }, title: t, rows: pl.rows.map((pr, k) => ({ n: k + 1, desc: desc({ desc: pr.row.desc, date: '' }), from: pr.from, to: pr.to, pages: pr.pages })) };
}

/** What Create Bundle produced; Save and the linked Word index use it. */
export interface Output { id: string; title: string; file: string; pages: number; indexPages: number; bodyPages: number; plan: Plan }
/** v5 cbBldIndexDocx: the Word index links into the bundle only when it was assembled from this very plan and title. */
export const linkable = (o: Output | null, pl: Plan, t: string): o is Output => !!o && o.title === t && o.plan.rows.length === pl.rows.length;

const row = (n: number, desc: string, pages: number, from: number, to: number, parts: BundleRow['parts']): BundleRow => ({
	n, key: '', desc, date: '', blank: false, missing: false, review: false, pages, from, to, sliceUrl: '', caselines: null, parts,
});
/** The builder's own Word index as a bundle: hyperlinked to `file` only when linkable. */
export function docxBundle(pl: Plan, t: string, o: Output | null): Bundle {
	const lk = linkable(o, pl, t);
	return { no: '', name: t, title: t, note: '', pages: pl.pages, indexPages: lk ? o.indexPages : 0, file: lk ? o.file : '', indexFile: '', rows: pl.rows.map((pr, k) => row(k + 1, pr.row.desc, pr.pages, pr.from, pr.to, [])) };
}

/** A bundle in the bundle list (v5 `ess_dcs_custom_bundles_v1` entry): the item list persists, the PDF does not. */
export interface CustomPart { rel: string; url: string; name: string; from: number; to: number }
export interface CustomRow { n: number; key: string; desc: string; pages: number; from: number; to: number; parts: CustomPart[] }
export interface Custom { no: string; name: string; pages: number; indexPages: number; filePages: number; note: string; rows: CustomRow[] }

export const SAVED_NOTE = 'Built in this app. The PDF stays available until this window is closed; the item list is kept.';
/** v5 cbBldSave numbering: the lowest C<i> no custom or shipped bundle uses. */
export function nextCustomNo(custom: readonly { no: string }[], shipped: readonly { no: string }[]): string {
	let i = 1;
	while (custom.some((c) => String(c.no) === 'C' + i) || shipped.some((b) => String(b.no) === 'C' + i)) i++;
	return 'C' + i;
}
/** v5 cbBldSave's entry for an output (its number assigned by the caller). */
export function savedBundle(o: Output, no: string): Custom {
	return {
		no, name: o.title, pages: o.bodyPages, indexPages: o.indexPages || 0, filePages: o.pages || 0, note: SAVED_NOTE,
		rows: o.plan.rows.map((pr, k) => ({ n: k + 1, key: '', desc: pr.row.desc, pages: pr.pages, from: pr.from, to: pr.to, parts: pr.segs.filter((s) => s.file).map((s) => ({ rel: s.file!.name, url: '', name: s.file!.name, from: s.from, to: s.to })) })),
	};
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** One custom bundle from untrusted data (v5 storage or a stored row), or null when it has no number. */
export function customOf(c: unknown): Custom | null {
	if (!rec(c) || (typeof c.no !== 'string' && typeof c.no !== 'number') || String(c.no).trim() === '') return null;
	return {
		no: String(c.no), name: str(c.name), pages: num(c.pages), indexPages: num(c.indexPages), filePages: num(c.filePages), note: str(c.note),
		rows: (Array.isArray(c.rows) ? c.rows : []).filter(rec).map((r, k) => ({
			n: typeof r.n === 'number' && Number.isFinite(r.n) ? r.n : k + 1, key: str(r.key), desc: str(r.desc), pages: num(r.pages), from: num(r.from), to: num(r.to),
			parts: (Array.isArray(r.parts) ? r.parts : []).filter(rec).map((p) => ({ rel: str(p.rel), url: str(p.url), name: str(p.name), from: num(p.from), to: num(p.to) })),
		})),
	};
}
/** The value of v5's `ess_dcs_custom_bundles_v1` (a JSON string or the parsed array) as custom bundles: entries without
 * a number are dropped, and a repeated number keeps its first entry. */
export function importV5CustomBundles(raw: unknown): Custom[] {
	let v = raw;
	if (typeof v === 'string') {
		try { v = JSON.parse(v); } catch { return []; }
	}
	if (!Array.isArray(v)) return [];
	const seen = new Set<string>();
	const out: Custom[] = [];
	for (const c of v.map(customOf)) if (c && !seen.has(c.no)) { seen.add(c.no); out.push(c); }
	return out;
}
/** v5 cbBundles for a custom entry: the list's bundle shape, with no file (S-court_bundle_tab-3: parts keep url ''). */
export function toBundle(c: Custom): Bundle {
	return {
		no: c.no, name: c.name, title: '(' + c.no + ') ' + c.name, note: c.note || 'Bundle created in this app.', pages: c.pages, indexPages: c.indexPages, file: '', indexFile: '',
		rows: c.rows.map((r) => row(r.n, r.desc, r.pages, r.from, r.to, r.parts.map((p) => ({ url: p.url, name: p.name, from: p.from, to: p.to })))),
	};
}
