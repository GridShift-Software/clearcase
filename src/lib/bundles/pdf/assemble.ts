import { INHERIT } from './doc.ts';
import type { Doc, PageEntry } from './doc.ts';
import { dec, enc, isDict, isName, nm, PRef, PStream } from './objects.ts';
import type { PDict, PdfValue } from './objects.ts';
import { clean, pdfText, textWidth } from './text.ts';
import { Copier, numOut, Out, str } from './writer.ts';

// ---------------------------------------------------------------- resource pruning
// A page's /Resources is often one dictionary shared by every page, listing every image in the file; copying it
// verbatim drags the whole source in. Only the names the page's content mentions are kept.
const RES_KEYS = ['XObject', 'Font', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'];

function namesIn(bytes: Uint8Array): Set<string> {
	const set = new Set<string>();
	const re = /\/([^\s/<>[\]()]+)/g;
	const s = dec(bytes);
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) set.add(m[1].replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
	return set;
}

const isForm = (doc: Doc, v: PdfValue | undefined): v is PStream => v instanceof PStream && isName(doc.get(v.d.get('Subtype')), 'Form');

async function contentBytes(doc: Doc, page: PDict): Promise<Uint8Array> {
	const c = page.get('Contents');
	const r = doc.get(c);
	const list = Array.isArray(r) ? r : c === undefined || c === null ? [] : [c];
	const parts: Uint8Array[] = [];
	for (const item of list) {
		const st = doc.get(item);
		if (st instanceof PStream) {
			try {
				parts.push(await doc.decode(st));
			} catch {
			}
		}
	}
	const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** The resource names a content stream needs, folding in Form XObjects that borrow the parent's resources. */
async function usedNames(doc: Doc, res: PDict, bytes: Uint8Array): Promise<Set<string> | null> {
	const used = namesIn(bytes);
	const xo = doc.get(res.get('XObject'));
	if (!isDict(xo)) return used;
	const done = new Set<string>();
	for (let rounds = 0; ; ) {
		let grew = false;
		for (const name of [...used]) {
			if (done.has(name)) continue;
			done.add(name);
			if (!xo.has(name)) continue;
			const v = doc.get(xo.get(name));
			if (!isForm(doc, v)) continue;
			const own = v.d.get('Resources');
			if (own !== undefined && own !== null) continue;
			try {
				for (const k of namesIn(await doc.decode(v)))
					if (!used.has(k)) {
						used.add(k);
						grew = true;
					}
			} catch {
				return null;
			}
		}
		if (!grew || ++rounds > 8) break;
	}
	return used;
}

async function pruneRes(doc: Doc, resRaw: PdfValue | undefined, bytes: Uint8Array, depth: number, seen: Set<string>): Promise<PdfValue | undefined> {
	const res = doc.get(resRaw);
	if (!isDict(res) || depth > 6 || !bytes.length) return res;
	const used = await usedNames(doc, res, bytes);
	if (!used) return res;
	const outRes: PDict = new Map();
	res.forEach((v, k) => {
		if (!RES_KEYS.includes(k)) outRes.set(k, v);
	});
	for (const key of RES_KEYS) {
		const sub = doc.get(res.get(key));
		if (!isDict(sub)) continue;
		const kept: PDict = new Map();
		for (let [name, val] of sub) {
			if (!used.has(name)) continue;
			if (key === 'XObject') {
				const xo = doc.get(val);
				if (isForm(doc, xo)) {
					const sig = val instanceof PRef ? val.num + '_' + val.gen : null;
					if (!sig || !seen.has(sig)) {
						if (sig) seen.add(sig);
						try {
							const fres = xo.d.get('Resources');
							if (fres !== undefined && fres !== null) {
								const nd: PDict = new Map(xo.d);
								nd.set('Resources', (await pruneRes(doc, fres, await doc.decode(xo), depth + 1, seen)) ?? null);
								val = new PStream(nd, xo.raw);
							}
						} catch {
						}
					}
				}
			}
			kept.set(name, val);
		}
		if (kept.size) outRes.set(key, kept);
	}
	return outRes;
}

const A4: [number, number, number, number] = [0, 0, 595.28, 841.89];

function box(doc: Doc, v: PdfValue | undefined): [number, number, number, number] | null {
	const b = doc.get(v);
	if (!Array.isArray(b) || b.length < 4) return null;
	const n = b.slice(0, 4).map((x) => doc.get(x));
	if (!n.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) return null;
	const [a, c, d, e] = n as number[];
	return [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)];
}

export function visibleBox(doc: Doc, p: PageEntry): [number, number, number, number] {
	const pick = (k: 'MediaBox' | 'CropBox') => (p.dict.get(k) !== undefined ? p.dict.get(k) : p.inh[k]);
	const mb = box(doc, pick('MediaBox')) ?? A4;
	const cb = box(doc, pick('CropBox'));
	if (!cb) return mb;
	const r: [number, number, number, number] = [Math.max(cb[0], mb[0]), Math.max(cb[1], mb[1]), Math.min(cb[2], mb[2]), Math.min(cb[3], mb[3])];
	return r[2] > r[0] && r[3] > r[1] ? r : mb;
}

export function stampOps(txt: string, b: readonly number[], rot: number): string {
	const [x0, y0, x1, y1] = b;
	const w = x1 - x0;
	const h = y1 - y0;
	const fs = 11;
	const pad = 18;
	const tw = textWidth(txt, fs);
	const m =
		rot === 90
			? [0, 1, -1, 0, x0 + pad, y0 + h / 2 - tw / 2]
			: rot === 180
				? [-1, 0, 0, -1, x0 + w / 2 + tw / 2, y1 - pad]
				: rot === 270
					? [0, -1, 1, 0, x1 - pad, y0 + h / 2 + tw / 2]
					: [1, 0, 0, 1, x0 + w / 2 - tw / 2, y0 + pad - 4];
	const tm = m.map(numOut).join(' ');
	const t = pdfText(txt);
	return `q\n1 1 1 rg\nBT /ZaPgNo ${fs} Tf 3 Tr ${tm} Tm (${t}) Tj ET\nQ\nq\n0 g\nBT /ZaPgNo ${fs} Tf ${tm} Tm (${t}) Tj ET\nQ\n`;
}

export interface IndexHeader {
	court: string;
	judge: string;
	caseNo: string;
	intro: string;
	claimant: string;
	claimantRole: string;
	defendant: string;
	defendantRole: string;
}
export interface IndexSpec {
	header: Partial<IndexHeader>;
	title: string;
	rows: { n: number; desc: string; from: number; to: number }[];
}

const pad3 = (n: number) => String(n).padStart(3, '0');
export const pageNos = (r: { from: number; to: number }) => (r.from && r.to ? (r.to > r.from ? `${pad3(r.from)} – ${pad3(r.to)}` : pad3(r.from)) : '');

type Link = { p: number; rect: number[]; t: number };

function wrap(raw: string, size: number, w: number): string[] {
	const words = clean(raw).split(/\s+/);
	const lines: string[] = [];
	let cur = '';
	for (const word of words) {
		const t = cur ? cur + ' ' + word : word;
		if (textWidth(t, size) > w && cur) {
			lines.push(cur);
			cur = word;
		} else cur = t;
		while (textWidth(cur, size) > w && cur.length > 1) {
			let k = cur.length;
			while (k > 1 && textWidth(cur.slice(0, k), size) > w) k--;
			lines.push(cur.slice(0, k));
			cur = cur.slice(k);
		}
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [''];
}
const mlwrap = (s: string, size: number, w: number) => String(s ?? '').split(/\r?\n/).flatMap((seg) => wrap(seg, size, w));

const helveticaBold = () =>
	new Map<string, PdfValue>([
		['Type', nm('Font')],
		['Subtype', nm('Type1')],
		['BaseFont', nm('Helvetica-Bold')],
		['Encoding', nm('WinAnsiEncoding')],
	]);

export function drawIndex(out: Out, spec: IndexSpec): { pages: PRef[]; links: Link[] } {
	const PW = 595.28;
	const PH = 841.89;
	const LM = 62;
	const RM = 62;
	const TM = 58;
	const BM = 52;
	const CW = PW - LM - RM;
	const C1 = CW * 0.09;
	const C2 = CW * 0.71;
	const C3 = CW * 0.2;
	const FS = 8.5;
	const LH = 11.1;
	const H = spec.header;
	const fontRef = out.add(helveticaBold());
	const pages: PRef[] = [];
	const links: Link[] = [];
	let ops: string[] = [];
	let y = 0;

	const T = (x: number, yy: number, s: string, size: number) =>
		ops.push(`BT /ZaIx ${numOut(size)} Tf 1 0 0 1 ${numOut(x)} ${numOut(yy)} Tm (${pdfText(clean(s))}) Tj ET`);
	const TC = (yy: number, s: string, size: number) => T(PW / 2 - textWidth(clean(s), size) / 2, yy, s, size);
	const TR = (yy: number, s: string, size: number) => T(PW - RM - textWidth(clean(s), size), yy, s, size);
	const flush = () => {
		if (!ops.length) return;
		const cs = out.add(new PStream(new Map(), enc(ops.join('\n') + '\n')));
		pages.push(
			out.add(
				new Map<string, PdfValue>([
					['Type', nm('Page')],
					['MediaBox', [0, 0, PW, PH]],
					['Resources', new Map([['Font', new Map([['ZaIx', fontRef]])]])],
					['Contents', cs],
				]),
			),
		);
		ops = [];
	};
	const head = (first: boolean) => {
		y = PH - TM;
		if (!first) {
			TC(y, 'INDEX: ' + spec.title + ' (continued)', 9);
			y -= 20;
			return;
		}
		for (const l of mlwrap(H.court ?? '', 10, CW)) {
			TC(y, l, 10);
			y -= 14;
		}
		if (H.judge) {
			y -= 2;
			for (const l of mlwrap(H.judge, 10, CW)) {
				TC(y, l, 10);
				y -= 14;
			}
		}
		y -= 10;
		TR(y, 'CASE NUMBER: ' + (H.caseNo ?? ''), 9);
		y -= 18;
		T(LM, y, H.intro || 'In the matter between:', 10);
		y -= 20;
		const parties: [string | undefined, string | undefined][] = [
			[H.claimant, H.claimantRole],
			[H.defendant, H.defendantRole],
		];
		parties.forEach(([name, role], k) => {
			if (k === 1) {
				T(LM, y, 'and', 10);
				y -= 20;
			}
			mlwrap(name ?? '', 10, CW - 130).forEach((l, i) => {
				T(LM, y, l, 10);
				if (i === 0) TR(y, role ?? '', 10);
				y -= 13;
			});
			y -= 8;
		});
		y -= 6;
		TC(y, 'INDEX', 11);
		y -= 15;
		TC(y, spec.title, 11);
		y -= 22;
	};

	head(true);
	for (const row of spec.rows) {
		const pn = pageNos(row);
		const cells = [wrap(row.n + '.', FS, C1 - 8), wrap(row.desc, FS, C2 - 8), wrap(pn, FS, C3 - 8)];
		const rh = Math.max(cells[0].length, cells[1].length, cells[2].length) * LH + 7;
		if (y - rh < BM) {
			flush();
			head(false);
		}
		const isL = !!(pn && row.from);
		let x = LM;
		ops.push('0.7 w');
		[C1, C2, C3].forEach((w, ci) => {
			ops.push(`${numOut(x)} ${numOut(y - rh)} ${numOut(w)} ${numOut(rh)} re S`);
			if (ci === 2 && isL) ops.push('0.05 0.2 0.55 rg');
			cells[ci].forEach((l, li) => T(x + 4, y - 11 - li * LH, l, FS));
			if (ci === 2 && isL) ops.push('0 g');
			x += w;
		});
		if (isL) links.push({ p: pages.length, rect: [LM, y - rh, PW - RM, y], t: row.from });
		y -= rh;
	}
	flush();
	return { pages, links };
}

function linkIndex(out: Out, idxPages: PRef[], links: Link[], dest: (t: number) => PDict | null) {
	const by = new Map<number, Link[]>();
	for (const L of links) by.set(L.p, [...(by.get(L.p) ?? []), L]);
	by.forEach((ls, p) => {
		const pref = idxPages[p];
		if (!pref) return;
		const annots: PRef[] = [];
		for (const L of ls) {
			const a = dest(L.t);
			if (!a) continue;
			annots.push(
				out.add(
					new Map<string, PdfValue>([
						['Type', nm('Annot')],
						['Subtype', nm('Link')],
						['Rect', L.rect],
						['Border', [0, 0, 0]],
						['F', 4],
						['H', nm('I')],
						['A', a],
					]),
				),
			);
		}
		if (annots.length) out.dict(pref).set('Annots', annots);
	});
}

export interface Source {
	doc: Doc;
	from: number;
	to: number;
	pages?: PageEntry[];
}
export interface Assembled {
	bytes: Uint8Array;
	pages: number;
	indexPages: number;
	bodyPages: number;
	map: { i: number; from: number; to: number; pages: number }[];
}

export async function assemble(
	sources: Source[],
	opts: { start?: number; index?: IndexSpec | null; onProgress?: (done: number, total: number, pages: number) => unknown } = {},
): Promise<Assembled> {
	const out = new Out();
	const catN = out.alloc();
	const pagesN = out.alloc();
	const cp = new Copier(out);
	const kids: PRef[] = [];
	const map: Assembled['map'] = [];
	const start = opts.start ?? 1;
	let n = start;
	const fontRef = out.add(helveticaBold());

	let idx: { pages: PRef[]; links: Link[] } = { pages: [], links: [] };
	if (opts.index) {
		idx = drawIndex(out, opts.index);
		kids.push(...idx.pages);
	}
	const indexPages = idx.pages.length;

	for (let s = 0; s < sources.length; s++) {
		const src = sources[s];
		const pgs = src.pages ?? src.doc.pages();
		const a = Math.max(1, src.from || 1);
		const z = Math.min(pgs.length, src.to || pgs.length);
		const startNo = n;
		for (let i = a; i <= z; i++) {
			const p = pgs[i - 1];
			if (!p) continue;
			let resSrc = p.dict.get('Resources');
			if (resSrc === undefined || resSrc === null) resSrc = p.inh.Resources;
			let pruned: PdfValue | undefined = undefined;
			if (resSrc !== undefined && resSrc !== null) {
				try {
					pruned = await pruneRes(src.doc, resSrc, await contentBytes(src.doc, p.dict), 0, new Set());
				} catch {
					pruned = src.doc.get(resSrc);
				}
			}
			const shallow: PDict = new Map(p.dict);
			// these go before the deep copy, or the whole page tree comes with it
			for (const k of ['Resources', 'Contents', 'Parent', 'Annots', 'B', 'StructParents', 'Tabs']) shallow.delete(k);
			const d = cp.copy(src.doc, shallow);
			if (!isDict(d)) continue;
			if (pruned !== undefined) d.set('Resources', cp.copy(src.doc, pruned));
			for (const k of INHERIT) if (k !== 'Resources' && d.get(k) === undefined && p.inh[k] !== undefined) d.set(k, cp.copy(src.doc, p.inh[k]));
			d.set('Type', nm('Page'));

			const vb = visibleBox(src.doc, p);
			const r0 = src.doc.get(p.dict.get('Rotate') ?? p.inh.Rotate);
			const rot = typeof r0 === 'number' ? (((Math.round(r0) % 360) + 360) % 360) : 0;

			// wrap the original content so the stamp starts from a clean graphics state
			// /Contents is a stream or an array of streams, direct or indirect: resolve it in the source, then flatten
			const c0 = p.dict.get('Contents');
			const cur = src.doc.get(c0);
			const arr = (Array.isArray(cur) ? cur : c0 !== undefined && c0 !== null ? [c0] : []).map((x) => cp.copy(src.doc, x));
			const pre = out.add(new PStream(new Map(), enc('q\n')));
			const post = out.add(new PStream(new Map(), enc('Q\n' + stampOps(String(n), vb, rot))));
			d.set('Contents', [pre, ...arr, post]);

			const r = d.get('Resources');
			const res: PDict = isDict(r) ? new Map(r) : new Map();
			const f = res.get('Font');
			const fonts: PDict = isDict(f) ? new Map(f) : f instanceof PRef ? new Map(copiedDict(out, f)) : new Map();
			fonts.set('ZaPgNo', fontRef);
			res.set('Font', fonts);
			d.set('Resources', res);
			d.set('Parent', new PRef(pagesN, 0));
			kids.push(out.add(d));
			n++;
		}
		map.push({ i: s, from: startNo, to: n - 1, pages: n - startNo });
		if (opts.onProgress) await opts.onProgress(s + 1, sources.length, n - 1);
	}

	if (idx.links.length) {
		linkIndex(out, idx.pages, idx.links, (t) => {
			const tgt = kids[indexPages + t - 1];
			return tgt
				? new Map<string, PdfValue>([
						['S', nm('GoTo')],
						['D', [tgt, nm('XYZ'), 0, 841.89, 0]],
					])
				: null;
		});
	}
	for (const r of idx.pages) out.dict(r).set('Parent', new PRef(pagesN, 0));
	out.put(
		pagesN,
		new Map<string, PdfValue>([
			['Type', nm('Pages')],
			['Kids', kids],
			['Count', kids.length],
		]),
	);
	out.put(
		catN,
		new Map<string, PdfValue>([
			['Type', nm('Catalog')],
			['Pages', new PRef(pagesN, 0)],
		]),
	);
	return { bytes: out.bytes([['Root', new PRef(catN, 0)]]), pages: kids.length, indexPages, bodyPages: n - start, map };
}

function copiedDict(out: Out, r: PRef): PDict {
	const d = out.objs[r.num];
	return d instanceof Map ? d : new Map();
}

export function indexOnly(spec: IndexSpec, remote: string, frontPages?: number): { bytes: Uint8Array; pages: number } {
	const out = new Out();
	const catN = out.alloc();
	const pagesN = out.alloc();
	const { pages, links } = drawIndex(out, spec);
	for (const r of pages) out.dict(r).set('Parent', new PRef(pagesN, 0));
	const front = frontPages ?? pages.length;
	if (remote && links.length) {
		linkIndex(
			out,
			pages,
			links,
			(t) =>
				new Map<string, PdfValue>([
					['S', nm('GoToR')],
					['F', str(remote)],
					['NewWindow', false],
					['D', [front + t - 1, nm('XYZ'), 0, 841.89, 0]],
				]),
		);
	}
	out.put(
		pagesN,
		new Map<string, PdfValue>([
			['Type', nm('Pages')],
			['Kids', pages],
			['Count', pages.length],
		]),
	);
	out.put(
		catN,
		new Map<string, PdfValue>([
			['Type', nm('Catalog')],
			['Pages', new PRef(pagesN, 0)],
		]),
	);
	return { bytes: out.bytes([['Root', new PRef(catN, 0)]]), pages: pages.length };
}
