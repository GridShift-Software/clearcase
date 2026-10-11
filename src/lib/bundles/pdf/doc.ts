/**
 * The PDF reader of the bundle builder (v5 PDFK `Doc`, main HTML 909-1232): classic xref tables, xref streams,
 * object streams and hybrid files, with a brute-force object scan when the xref is broken. An encrypted file is
 * refused with `EncryptedPdfError`.
 */
import { asciiHexDecode, dec, find, isDict, isName, isWS, Lex, PRef, PStream, rfind } from './objects.ts';
import type { PDict, PdfValue, Resolver } from './objects.ts';

export class EncryptedPdfError extends Error {
	constructor() {
		super('ENCRYPTED');
		this.name = 'EncryptedPdfError';
	}
}

type XrefEntry = { off?: number; strm?: number; i?: number };
export type PageEntry = { ref: PRef | null; dict: PDict; inh: Partial<Record<(typeof INHERIT)[number], PdfValue>> };

export const INHERIT = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/** A raw zlib stream inflated by the platform's own decompressor (browser, Bun and Node alike). */
async function inflate(buf: Uint8Array): Promise<Uint8Array> {
	for (const kind of ['deflate', 'deflate-raw'] as const) {
		try {
			const s = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(kind));
			return new Uint8Array(await new Response(s).arrayBuffer());
		} catch {
			/* the next flavour */
		}
	}
	throw new Error('could not inflate stream');
}

function a85(b: Uint8Array): Uint8Array {
	const out: number[] = [];
	let t = 0;
	let n = 0;
	let i = b[0] === 0x3c && b[1] === 0x7e ? 2 : 0;
	for (; i < b.length; i++) {
		const c = b[i];
		if (c === 0x7e) break;
		if (isWS(c)) continue;
		if (c === 0x7a && n === 0) {
			out.push(0, 0, 0, 0);
			continue;
		}
		t = t * 85 + (c - 33);
		n++;
		if (n === 5) {
			out.push((t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
			t = 0;
			n = 0;
		}
	}
	if (n > 0) {
		for (let k = n; k < 5; k++) t = t * 85 + 84;
		const by = [(t / 16777216) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255];
		for (let j = 0; j < n - 1; j++) out.push(by[j]);
	}
	return new Uint8Array(out);
}

const int = (v: PdfValue | undefined, d: number) => (typeof v === 'number' ? v | 0 : d);

/** PNG predictors (TIFF predictor 2 passes through, as in v5). */
function unpredict(data: Uint8Array, p: PDict): Uint8Array {
	const pred = int(p.get('Predictor'), 0);
	if (pred < 2) return data;
	const colors = int(p.get('Colors'), 1) || 1;
	const bpc = int(p.get('BitsPerComponent'), 8) || 8;
	const cols = int(p.get('Columns'), 1) || 1;
	const bpp = Math.ceil((colors * bpc) / 8);
	const rb = Math.ceil((colors * bpc * cols) / 8);
	if (pred === 2) return data;
	const rows = Math.floor(data.length / (rb + 1));
	const out = new Uint8Array(rows * rb);
	let prev = new Uint8Array(rb);
	for (let r = 0; r < rows; r++) {
		const ft = data[r * (rb + 1)];
		const src = r * (rb + 1) + 1;
		const dst = r * rb;
		for (let i = 0; i < rb; i++) {
			const x = data[src + i];
			const a = i >= bpp ? out[dst + i - bpp] : 0;
			const b2 = prev[i];
			const c = i >= bpp ? prev[i - bpp] : 0;
			let v: number;
			if (ft === 1) v = x + a;
			else if (ft === 2) v = x + b2;
			else if (ft === 3) v = x + ((a + b2) >> 1);
			else if (ft === 4) {
				const pp = a + b2 - c;
				const pa = Math.abs(pp - a);
				const pb = Math.abs(pp - b2);
				const pc = Math.abs(pp - c);
				v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c);
			} else v = x;
			out[dst + i] = v & 255;
		}
		prev = out.subarray(dst, dst + rb);
	}
	return out;
}

export class Doc implements Resolver {
	readonly b: Uint8Array;
	readonly xref = new Map<number, XrefEntry>();
	readonly trailer: PDict = new Map();
	readonly cache = new Map<number, PdfValue>();
	readonly objstm = new Map<number, Map<number, PdfValue>>();
	private scanned: Map<number, XrefEntry> | null = null;

	constructor(buf: ArrayBuffer | Uint8Array) {
		this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	}

	/** Brute-force map of "N G obj" offsets. */
	scan(): Map<number, XrefEntry> {
		if (this.scanned) return this.scanned;
		const b = this.b;
		const m = new Map<number, XrefEntry>();
		let i = 0;
		for (;;) {
			i = find(b, ' obj', i);
			if (i < 0) break;
			let k = i;
			while (k > 0 && b[k - 1] >= 0x30 && b[k - 1] <= 0x39) k--;
			if (k === i) {
				i += 4;
				continue;
			}
			const gs = k;
			while (k > 0 && isWS(b[k - 1])) k--;
			if (k === gs) {
				i += 4;
				continue;
			}
			const ne = k;
			while (k > 0 && b[k - 1] >= 0x30 && b[k - 1] <= 0x39) k--;
			if (k === ne) {
				i += 4;
				continue;
			}
			m.set(parseInt(dec(b, k, ne), 10), { off: k });
			i += 4;
		}
		return (this.scanned = m);
	}

	async load(): Promise<this> {
		const b = this.b;
		const sx = rfind(b, 'startxref');
		let ok = false;
		if (sx >= 0) {
			const off = new Lex(b, sx + 9).obj(this);
			try {
				ok = await this.readXref(off, new Set());
			} catch {
				ok = false;
			}
		}
		if (!ok || !this.trailer.get('Root')) await this.recover();
		if (this.trailer.get('Encrypt')) throw new EncryptedPdfError();
		return this;
	}

	private async recover() {
		const m = this.scan();
		m.forEach((v, k) => {
			if (!this.xref.has(k)) this.xref.set(k, v);
		});
		if (!this.trailer.get('Root')) {
			let t = rfind(this.b, 'trailer');
			while (t >= 0) {
				const d = new Lex(this.b, t + 7).obj(this);
				if (isDict(d) && d.get('Root')) {
					this.mergeTrailer(d);
					break;
				}
				t = rfind(this.b, 'trailer', t - 1);
			}
		}
		if (!this.trailer.get('Root')) {
			for (const k of m.keys()) {
				const o = this.getNum(k);
				if (isDict(o) && isName(o.get('Type'), 'Catalog')) {
					this.trailer.set('Root', new PRef(k, 0));
					break;
				}
			}
		}
		if (!this.trailer.get('Root')) {
			// object streams may hold the catalogue and the page tree
			for (const k of m.keys()) {
				const s = this.getNum(k);
				if (s instanceof PStream && isName(s.d.get('Type'), 'ObjStm')) {
					try {
						await this.loadObjStm(k);
					} catch {
						/* skip it */
					}
				}
			}
			this.objstm.forEach((map, sn) => {
				map.forEach((v, k) => {
					if (!this.trailer.get('Root') && isDict(v) && isName(v.get('Type'), 'Catalog')) this.trailer.set('Root', new PRef(k, 0));
					if (!this.xref.has(k)) this.xref.set(k, { strm: sn });
				});
			});
		}
	}

	private mergeTrailer(d: PDict) {
		d.forEach((v, k) => {
			if (!this.trailer.has(k)) this.trailer.set(k, v);
		});
	}

	private async readXref(off: PdfValue | undefined, seen: Set<number>): Promise<boolean> {
		if (typeof off !== 'number' || off < 0 || off >= this.b.length) return false;
		if (seen.has(off)) return true;
		seen.add(off);
		const lx = new Lex(this.b, off);
		if (lx.peek() === 'xref') {
			lx.token();
			for (;;) {
				const p = lx.peek();
				if (p === 'trailer' || p === null) break;
				const start = lx.obj(this);
				const count = lx.obj(this);
				if (typeof start !== 'number' || typeof count !== 'number') break;
				lx.ws();
				// an entry is at least 18 bytes, so a count beyond the bytes left is damage; stop at the end of the file
				for (let i = 0, n = Math.min(count, Math.ceil((this.b.length - lx.p) / 18)); i < n; i++) {
					const o = lx.obj(this);
					lx.obj(this);
					const ty = lx.token();
					if (ty === null) break;
					if (ty === 'n' && typeof o === 'number' && !this.xref.has(start + i)) this.xref.set(start + i, { off: o });
				}
			}
			if (lx.token() === 'trailer') {
				const d = lx.obj(this);
				if (isDict(d)) {
					this.mergeTrailer(d);
					if (d.get('XRefStm') !== undefined) {
						try {
							await this.readXref(d.get('XRefStm'), seen);
						} catch {
							/* the classic table still stands */
						}
					}
					if (d.get('Prev') !== undefined) await this.readXref(d.get('Prev'), seen);
				}
			}
			return true;
		}
		// a cross-reference stream: "N G obj << … >> stream"
		lx.token();
		lx.token();
		if (lx.token() !== 'obj') return false;
		const s = lx.obj(this);
		if (!(s instanceof PStream)) return false;
		const data = await this.decode(s);
		const W = s.d.get('W');
		const w = Array.isArray(W) ? W.map((x) => (typeof x === 'number' ? x | 0 : 0)) : [];
		const size = s.d.get('Size');
		const ix = s.d.get('Index');
		const index = Array.isArray(ix) ? ix.map((x) => (typeof x === 'number' ? x : 0)) : [0, typeof size === 'number' ? size : 0];
		const rl = w.reduce((a, x) => a + x, 0);
		if (!(rl > 0)) return false;
		let pos = 0;
		for (let k = 0; k + 1 < index.length; k += 2) {
			const st = index[k];
			const cn = index[k + 1];
			for (let j = 0; j < cn && pos + rl <= data.length; j++, pos += rl) {
				const f: number[] = [];
				let q = pos;
				for (let z = 0; z < w.length; z++) {
					let v = 0;
					for (let y = 0; y < w[z]; y++) v = v * 256 + data[q++];
					f.push(w[z] === 0 ? (z === 0 ? 1 : 0) : v);
				}
				const num = st + j;
				if (this.xref.has(num)) continue;
				if (f[0] === 1) this.xref.set(num, { off: f[1] });
				else if (f[0] === 2) this.xref.set(num, { strm: f[1], i: f[2] });
			}
		}
		this.mergeTrailer(s.d);
		if (s.d.get('Prev') !== undefined) await this.readXref(s.d.get('Prev'), seen);
		return true;
	}

	/** A stream's decoded bytes: FlateDecode, ASCIIHexDecode and ASCII85Decode, with PNG predictors. */
	async decode(s: PStream): Promise<Uint8Array> {
		const f = s.d.get('Filter');
		const fs = f == null ? [] : Array.isArray(f) ? f : [f];
		const pm = s.d.get('DecodeParms');
		const pms = pm == null ? [] : Array.isArray(pm) ? pm : [pm];
		let raw = s.raw;
		for (let i = 0; i < fs.length; i++) {
			const n = isName(fs[i]) ? (fs[i] as { n: string }).n : '';
			if (n === 'FlateDecode') raw = await inflate(raw);
			else if (n === 'ASCIIHexDecode') raw = asciiHexDecode(raw);
			else if (n === 'ASCII85Decode') raw = a85(raw);
			else throw new Error('unsupported filter ' + n);
			const p = this.get(pms[i]);
			if (isDict(p) && typeof p.get('Predictor') === 'number' && (p.get('Predictor') as number) > 1) raw = unpredict(raw, p);
		}
		return raw;
	}

	private async loadObjStm(sn: number): Promise<Map<number, PdfValue>> {
		const have = this.objstm.get(sn);
		if (have) return have;
		const s = this.getNum(sn);
		const map = new Map<number, PdfValue>();
		this.objstm.set(sn, map);
		if (!(s instanceof PStream)) return map;
		const data = await this.decode(s);
		const n = int(s.d.get('N'), 0);
		const first = int(s.d.get('First'), 0);
		const hl = new Lex(data, 0);
		const pairs: [number, number][] = [];
		for (let i = 0; i < n; i++) {
			const a = hl.obj(this);
			const b = hl.obj(this);
			if (typeof a !== 'number' || typeof b !== 'number') break;
			pairs.push([a, b]);
		}
		for (const [num, off] of pairs) map.set(num, new Lex(data, first + off).obj(this) ?? null);
		return map;
	}

	getNum(num: number): PdfValue {
		if (this.cache.has(num)) return this.cache.get(num) ?? null;
		const e = this.xref.get(num);
		this.cache.set(num, null); // cycle guard
		let v: PdfValue | undefined = null;
		if (e?.off !== undefined) v = this.at(e.off, num);
		if (v === null && e?.strm !== undefined) {
			const m = this.objstm.get(e.strm);
			v = m ? (m.has(num) ? (m.get(num) ?? null) : null) : undefined;
		}
		if (v === null || v === undefined) {
			const sc = this.scan().get(num);
			if (sc?.off !== undefined) v = this.at(sc.off, num);
		}
		this.cache.set(num, v ?? null);
		return v ?? null;
	}

	private at(off: number, num?: number): PdfValue {
		if (off < 0 || off >= this.b.length) return null;
		const lx = new Lex(this.b, off);
		const a = lx.token();
		lx.token();
		if (lx.token() !== 'obj' || (num !== undefined && parseInt(a ?? '', 10) !== num)) return null;
		return lx.obj(this) ?? null;
	}

	/** A value with indirect references followed (at most 64 deep). */
	get(v: PdfValue | undefined): PdfValue | undefined {
		let guard = 0;
		while (v instanceof PRef && guard++ < 64) v = this.getNum(v.num);
		return v;
	}

	/** Every object stream loaded, so getNum never misses. */
	async preload(): Promise<this> {
		const need = new Set<number>();
		this.xref.forEach((e) => {
			if (e.strm !== undefined) need.add(e.strm);
		});
		for (const sn of need) {
			try {
				await this.loadObjStm(sn);
			} catch {
				/* that stream's objects stay unreadable */
			}
		}
		this.cache.clear();
		return this;
	}

	/** The pages in order, each with its inherited attributes; recovery takes any /Type /Page object. */
	pages(): PageEntry[] {
		const root = this.get(this.trailer.get('Root'));
		const out: PageEntry[] = [];
		const seen = new Set<number>();
		const walk = (refOrDict: PdfValue | undefined, inh: PageEntry['inh'], depth: number) => {
			if (depth > 64 || out.length > 100000) return;
			if (refOrDict instanceof PRef) {
				if (seen.has(refOrDict.num)) return;
				seen.add(refOrDict.num);
			}
			const d = this.get(refOrDict);
			if (!isDict(d)) return;
			const mine = { ...inh };
			for (const k of INHERIT) if (d.get(k) !== undefined) mine[k] = d.get(k);
			const kids = this.get(d.get('Kids'));
			if (Array.isArray(kids) && !isName(d.get('Type'), 'Page')) {
				for (const kid of kids) walk(kid, mine, depth + 1);
			} else if (isName(d.get('Type'), 'Page') || d.get('Contents') !== undefined) {
				out.push({ ref: refOrDict instanceof PRef ? refOrDict : null, dict: d, inh: mine });
			}
		};
		walk(isDict(root) ? root.get('Pages') : null, {}, 0);
		if (!out.length) {
			this.xref.forEach((_e, num) => {
				const o = this.getNum(num);
				if (isDict(o) && isName(o.get('Type'), 'Page')) out.push({ ref: new PRef(num, 0), dict: o, inh: {} });
			});
		}
		return out;
	}
}

/** Open a PDF from its bytes; throws EncryptedPdfError for an encrypted file. */
export async function open(buf: ArrayBuffer | Uint8Array): Promise<Doc> {
	const d = new Doc(buf);
	await d.load();
	await d.preload();
	// v5 accepted a file with no readable page and built nothing from it; say so when the file is added instead.
	if (!d.pages().length) throw new Error('no pages could be read from it');
	return d;
}
