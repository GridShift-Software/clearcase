/**
 * PDF objects, byte helpers and the lexer of the bundle builder's PDF engine: a TypeScript port of v5's PDFK
 * (main HTML 691-907). Everything runs in the browser on the bytes of a picked file; nothing is uploaded.
 */

export class PName {
	readonly n: string;
	constructor(n: string) {
		this.n = n;
	}
}
export class PRef {
	readonly num: number;
	readonly gen: number;
	constructor(num: number, gen = 0) {
		this.num = num;
		this.gen = gen;
	}
}
export class PStr {
	readonly b: Uint8Array;
	readonly hex: boolean;
	constructor(b: Uint8Array, hex = false) {
		this.b = b;
		this.hex = hex;
	}
}
export type PDict = Map<string, PdfValue>;
export class PStream {
	readonly d: PDict;
	readonly raw: Uint8Array;
	constructor(d: PDict, raw: Uint8Array) {
		this.d = d;
		this.raw = raw;
	}
}
export type PdfValue = null | boolean | number | PName | PRef | PStr | PStream | PdfValue[] | PDict;

const NAMES = new Map<string, PName>();
/** One PName per name, so names compare by identity as well as by `.n`. */
export function nm(s: string): PName {
	let v = NAMES.get(s);
	if (!v) NAMES.set(s, (v = new PName(s)));
	return v;
}
export const isName = (v: unknown, s?: string): v is PName => v instanceof PName && (s === undefined || v.n === s);
export const isDict = (v: unknown): v is PDict => v instanceof Map;

/** Latin-1 bytes of a string whose characters are all below 256 (higher ones keep their low byte, as v5's enc). */
export function enc(s: string): Uint8Array {
	const a = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
	return a;
}
export function dec(b: Uint8Array, from = 0, to = b.length): string {
	let s = '';
	for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
	return s;
}
export function find(b: Uint8Array, needle: string, from = 0): number {
	const n = enc(needle);
	const lim = b.length - n.length;
	outer: for (let i = from; i <= lim; i++) {
		for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
		return i;
	}
	return -1;
}
export function rfind(b: Uint8Array, needle: string, from = b.length): number {
	const n = enc(needle);
	outer: for (let i = Math.min(from, b.length - n.length); i >= 0; i--) {
		for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
		return i;
	}
	return -1;
}
export const isWS = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x00 || c === 0x0c;
export const isDelim = (c: number) =>
	c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

/** What the lexer needs from a document: resolving an indirect /Length. */
export interface Resolver {
	get(v: PdfValue | undefined): PdfValue | undefined;
}

/** `undefined` from obj() means a closing delimiter (or nothing parseable) was met. */
export class Lex {
	readonly b: Uint8Array;
	p: number;
	constructor(b: Uint8Array, p = 0) {
		this.b = b;
		this.p = p;
	}
	ws() {
		const b = this.b;
		for (;;) {
			while (this.p < b.length && isWS(b[this.p])) this.p++;
			if (b[this.p] === 0x25) {
				while (this.p < b.length && b[this.p] !== 0x0a && b[this.p] !== 0x0d) this.p++;
			} else return;
		}
	}
	token(): string | null {
		this.ws();
		const b = this.b;
		const s = this.p;
		if (s >= b.length) return null;
		const c = b[s];
		if (c === 0x3c && b[s + 1] === 0x3c) {
			this.p += 2;
			return '<<';
		}
		if (c === 0x3e && b[s + 1] === 0x3e) {
			this.p += 2;
			return '>>';
		}
		if (isDelim(c)) {
			this.p++;
			return String.fromCharCode(c);
		}
		while (this.p < b.length && !isWS(b[this.p]) && !isDelim(b[this.p])) this.p++;
		return dec(b, s, this.p);
	}
	peek(): string | null {
		const q = this.p;
		const t = this.token();
		this.p = q;
		return t;
	}
	/** '/' already consumed; #xx escapes decoded. */
	name(): PName {
		const b = this.b;
		const s = this.p;
		while (this.p < b.length && !isWS(b[this.p]) && !isDelim(b[this.p])) this.p++;
		const raw = dec(b, s, this.p);
		let out = '';
		for (let i = 0; i < raw.length; i++) {
			if (raw[i] === '#' && i + 2 < raw.length) {
				out += String.fromCharCode(parseInt(raw.substr(i + 1, 2), 16));
				i += 2;
			} else out += raw[i];
		}
		return nm(out);
	}
	/** '(' already consumed. */
	litstr(): PStr {
		const b = this.b;
		const out: number[] = [];
		let depth = 1;
		while (this.p < b.length) {
			const c = b[this.p++];
			if (c === 0x5c) {
				const e = b[this.p++];
				if (e === 0x6e) out.push(10);
				else if (e === 0x72) out.push(13);
				else if (e === 0x74) out.push(9);
				else if (e === 0x62) out.push(8);
				else if (e === 0x66) out.push(12);
				else if (e >= 0x30 && e <= 0x37) {
					let o = e - 0x30;
					let k = 0;
					while (k < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37) {
						o = o * 8 + (b[this.p++] - 0x30);
						k++;
					}
					out.push(o & 0xff);
				} else if (e !== 0x0a) out.push(e);
			} else if (c === 0x28) {
				depth++;
				out.push(c);
			} else if (c === 0x29) {
				if (--depth === 0) break;
				out.push(c);
			} else out.push(c);
		}
		return new PStr(new Uint8Array(out), false);
	}
	/** '<' already consumed. */
	hexstr(): PStr {
		return new PStr(hexBytes(this), true);
	}
	/** One object. `doc` lets a stream's indirect /Length resolve. */
	obj(doc?: Resolver): PdfValue | undefined {
		this.ws();
		const b = this.b;
		const c = b[this.p];
		if (this.p >= b.length) return null;
		if (c === 0x2f) {
			this.p++;
			return this.name();
		}
		if (c === 0x28) {
			this.p++;
			return this.litstr();
		}
		if (c === 0x3c) {
			if (b[this.p + 1] === 0x3c) {
				this.p += 2;
				return this.dict(doc);
			}
			this.p++;
			return this.hexstr();
		}
		if (c === 0x5b) {
			this.p++;
			const arr: PdfValue[] = [];
			for (;;) {
				this.ws();
				if (this.p >= b.length) break;
				if (b[this.p] === 0x5d) {
					this.p++;
					break;
				}
				const v = this.obj(doc);
				if (v === undefined) break;
				arr.push(v);
			}
			return arr;
		}
		if (c === 0x5d || c === 0x3e || c === 0x7d || c === 0x29) {
			this.p++;
			return undefined;
		}
		const save = this.p;
		const t = this.token();
		if (t === null) return null;
		if (t === 'true') return true;
		if (t === 'false') return false;
		if (t === 'null') return null;
		if (/^[+-]?[\d.]+$/.test(t)) {
			if (/^\d+$/.test(t)) {
				const q = this.p;
				const t2 = this.token();
				if (t2 !== null && /^\d+$/.test(t2)) {
					const q2 = this.p;
					if (this.token() === 'R') return new PRef(parseInt(t, 10), parseInt(t2, 10));
					this.p = q2;
				}
				this.p = q;
			}
			return parseFloat(t);
		}
		this.p = save + Math.max(1, t.length);
		return nm(t); // a keyword not modelled
	}
	/** '<<' already consumed; a following `stream` makes it a PStream. */
	dict(doc?: Resolver): PDict | PStream {
		const d: PDict = new Map();
		const b = this.b;
		for (;;) {
			this.ws();
			if (this.p >= b.length) break;
			if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) {
				this.p += 2;
				break;
			}
			if (b[this.p] !== 0x2f) {
				if (this.obj(doc) === undefined) break;
				continue;
			}
			this.p++;
			const k = this.name().n;
			const v = this.obj(doc);
			d.set(k, v === undefined ? null : v);
		}
		const q = this.p;
		if (this.token() === 'stream') {
			if (b[this.p] === 0x0d) this.p++;
			if (b[this.p] === 0x0a) this.p++;
			const st = this.p;
			let len = d.get('Length');
			if (len instanceof PRef && doc) len = doc.get(len) ?? null;
			let end = -1;
			if (typeof len === 'number' && len >= 0 && st + len <= b.length) {
				end = st + len;
				if (new Lex(b, end).peek() !== 'endstream') end = -1;
			}
			if (end < 0) {
				end = find(b, 'endstream', st);
				if (end < 0) end = b.length;
				if (b[end - 1] === 0x0a) end--;
				if (b[end - 1] === 0x0d) end--;
			}
			const raw = b.subarray(st, end);
			const e = find(b, 'endstream', end);
			this.p = e < 0 ? b.length : e + 9;
			return new PStream(d, raw);
		}
		this.p = q;
		return d;
	}
}

/** Hex digits up to '>' (or the end), odd digit padded with 0: shared by hex strings and ASCIIHexDecode. */
function hexBytes(src: { b: Uint8Array; p: number }): Uint8Array {
	const b = src.b;
	const out: number[] = [];
	let hi = -1;
	while (src.p < b.length) {
		const c = b[src.p++];
		if (c === 0x3e) break;
		let v = -1;
		if (c >= 0x30 && c <= 0x39) v = c - 0x30;
		else if (c >= 0x41 && c <= 0x46) v = c - 55;
		else if (c >= 0x61 && c <= 0x66) v = c - 87;
		else continue;
		if (hi < 0) hi = v;
		else {
			out.push(hi * 16 + v);
			hi = -1;
		}
	}
	if (hi >= 0) out.push(hi * 16);
	return new Uint8Array(out);
}
export const asciiHexDecode = (b: Uint8Array) => hexBytes({ b, p: 0 });
