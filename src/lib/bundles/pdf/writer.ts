import { enc, isDelim, PName, PRef, PStr, PStream } from './objects.ts';
import type { PDict, PdfValue } from './objects.ts';
import type { Doc } from './doc.ts';

export function nameOut(s: string): string {
	let o = '/';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x21 || c > 0x7e || isDelim(c) || c === 0x23) o += '#' + ('0' + (c & 0xff).toString(16)).slice(-2);
		else o += s[i];
	}
	return o;
}

export function numOut(n: number): string {
	if (!Number.isFinite(n)) return '0';
	if (Number.isInteger(n)) return String(n);
	const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	return s === '' || s === '-' || s === '-0' ? '0' : s;
}

function esc(bytes: Uint8Array): Uint8Array {
	const out = [0x28];
	for (const c of bytes) {
		if (c === 0x28 || c === 0x29 || c === 0x5c) out.push(0x5c, c);
		else if (c === 0x0d) out.push(0x5c, 0x72);
		else if (c === 0x0a) out.push(0x5c, 0x6e);
		else out.push(c);
	}
	out.push(0x29);
	return new Uint8Array(out);
}

function ser(v: PdfValue | undefined, push: (b: Uint8Array) => void): void {
	if (v === null || v === undefined) return push(enc('null'));
	if (typeof v === 'number') return push(enc(numOut(v)));
	if (typeof v === 'boolean') return push(enc(v ? 'true' : 'false'));
	if (v instanceof PName) return push(enc(nameOut(v.n)));
	if (v instanceof PRef) return push(enc(v.num + ' ' + v.gen + ' R'));
	if (v instanceof PStr) {
		if (!v.hex) return push(esc(v.b));
		let h = '<';
		for (const c of v.b) h += ('0' + c.toString(16)).slice(-2);
		return push(enc(h + '>'));
	}
	if (Array.isArray(v)) {
		push(enc('['));
		v.forEach((x, k) => {
			if (k) push(enc(' '));
			ser(x, push);
		});
		return push(enc(']'));
	}
	if (v instanceof Map) {
		push(enc('<<'));
		v.forEach((val, key) => {
			push(enc(nameOut(key) + ' '));
			ser(val, push);
			push(enc(' '));
		});
		return push(enc('>>'));
	}
	if (v instanceof PStream) {
		const d: PDict = new Map(v.d);
		d.set('Length', v.raw.length);
		ser(d, push);
		push(enc('\nstream\n'));
		push(v.raw);
		return push(enc('\nendstream'));
	}
	push(enc('null'));
}

export class Out {
	readonly objs: (PdfValue | undefined)[] = [null];
	alloc(): number {
		this.objs.push(undefined);
		return this.objs.length - 1;
	}
	put(n: number, v: PdfValue): PRef {
		this.objs[n] = v;
		return new PRef(n, 0);
	}
	add(v: PdfValue): PRef {
		return this.put(this.alloc(), v);
	}
	dict(r: PRef): PDict {
		const d = this.objs[r.num];
		if (!(d instanceof Map)) throw new Error('object ' + r.num + ' is not a dictionary');
		return d;
	}
	bytes(trailer: [string, PRef][]): Uint8Array {
		const parts: Uint8Array[] = [];
		let len = 0;
		const offs = new Array<number>(this.objs.length).fill(0);
		const push = (b: Uint8Array) => {
			parts.push(b);
			len += b.length;
		};
		push(enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));
		for (let i = 1; i < this.objs.length; i++) {
			offs[i] = len;
			push(enc(i + ' 0 obj\n'));
			ser(this.objs[i] ?? null, push);
			push(enc('\nendobj\n'));
		}
		const xr = len;
		let s = 'xref\n0 ' + this.objs.length + '\n0000000000 65535 f \n';
		for (let j = 1; j < this.objs.length; j++) s += ('0000000000' + offs[j]).slice(-10) + ' 00000 n \n';
		s += 'trailer\n<< /Size ' + this.objs.length;
		for (const [k, r] of trailer) s += ' ' + nameOut(k) + ' ' + r.num + ' ' + r.gen + ' R';
		s += ' >>\nstartxref\n' + xr + '\n%%EOF\n';
		push(enc(s));
		const out = new Uint8Array(len);
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return out;
	}
}

export class Copier {
	private readonly out: Out;
	private readonly maps = new Map<Doc, Map<number, PRef>>();
	constructor(out: Out) {
		this.out = out;
	}
	copy(doc: Doc, v: PdfValue | undefined, depth = 0): PdfValue {
		if (depth > 200 || v === undefined) return null;
		if (v instanceof PRef) {
			let m = this.maps.get(doc);
			if (!m) this.maps.set(doc, (m = new Map()));
			const have = m.get(v.num);
			if (have) return have;
			const n = this.out.alloc();
			const r = new PRef(n, 0);
			m.set(v.num, r);
			this.out.put(n, this.copy(doc, doc.getNum(v.num), depth + 1));
			return r;
		}
		if (Array.isArray(v)) return v.map((x) => this.copy(doc, x, depth + 1));
		if (v instanceof Map) {
			const d: PDict = new Map();
			v.forEach((val, key) => d.set(key, this.copy(doc, val, depth + 1)));
			return d;
		}
		if (v instanceof PStream) {
			const d: PDict = new Map();
			v.d.forEach((val, key) => {
				if (key !== 'Length') d.set(key, this.copy(doc, val, depth + 1));
			});
			return new PStream(d, v.raw);
		}
		return v;
	}
}

/** A literal string from text: PDFDocEncoding below 256, '?' above (v5 `str`). */
export function str(s: string): PStr {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		b[i] = c < 256 ? c : 0x3f;
	}
	return new PStr(b, false);
}
