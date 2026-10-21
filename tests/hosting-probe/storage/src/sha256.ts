// SHA-256 (FIPS 180-4) whose state survives between invocations. An export step that stops inside an entry stores the
// state, and the next step continues it, so an entry spanning parts is hashed over exactly the bytes written into the
// packet. workerd's DigestStream cannot export its state, and R2 needs every part but the last to be the same size.
const K = Int32Array.from([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export type Sha256State = { h: number[]; tail: string; length: number };

function block(h: Int32Array, w: Int32Array, bytes: Uint8Array, o: number) {
	for (let i = 0; i < 16; i++, o += 4) w[i] = (bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!;
	for (let i = 16; i < 64; i++) {
		const x = w[i - 15]!;
		const y = w[i - 2]!;
		const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
		const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
		w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
	}
	let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
	for (let i = 0; i < 64; i++) {
		const t1 = (k + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
		const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
		k = g;
		g = f;
		f = e;
		e = (d + t1) | 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) | 0;
	}
	h[0] = (h[0]! + a) | 0;
	h[1] = (h[1]! + b) | 0;
	h[2] = (h[2]! + c) | 0;
	h[3] = (h[3]! + d) | 0;
	h[4] = (h[4]! + e) | 0;
	h[5] = (h[5]! + f) | 0;
	h[6] = (h[6]! + g) | 0;
	h[7] = (h[7]! + k) | 0;
}

export class Sha256 {
	private readonly h: Int32Array;
	private readonly w = new Int32Array(64);
	private readonly buf = new Uint8Array(64);
	private used = 0;
	private length = 0;

	constructor(state?: Sha256State) {
		this.h = Int32Array.from(state?.h ?? IV);
		if (state) {
			const tail = state.tail.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
			if (this.h.length !== 8 || tail.length >= 64 || !Number.isSafeInteger(state.length) || state.length % 64 !== tail.length) throw new Error('invalid SHA-256 state');
			this.buf.set(tail);
			this.used = tail.length;
			this.length = state.length;
		}
	}

	update(data: Uint8Array): this {
		const n = data.length;
		this.length += n;
		let i = 0;
		if (this.used > 0) {
			i = Math.min(64 - this.used, n);
			this.buf.set(data.subarray(0, i), this.used);
			this.used += i;
			if (this.used < 64) return this;
			block(this.h, this.w, this.buf, 0);
			this.used = 0;
		}
		for (; i + 64 <= n; i += 64) block(this.h, this.w, data, i);
		if (i < n) {
			this.buf.set(data.subarray(i), 0);
			this.used = n - i;
		}
		return this;
	}

	state(): Sha256State {
		return { h: [...this.h], tail: [...this.buf.subarray(0, this.used)].map((x) => x.toString(16).padStart(2, '0')).join(''), length: this.length };
	}

	/** The digest of everything so far, as lowercase hex; the state is unchanged. */
	hex(): string {
		const pad = new Uint8Array(this.used < 56 ? 64 : 128);
		pad.set(this.buf.subarray(0, this.used));
		pad[this.used] = 0x80;
		const view = new DataView(pad.buffer);
		view.setUint32(pad.length - 8, Math.floor(this.length / 0x20000000));
		view.setUint32(pad.length - 4, (this.length * 8) >>> 0);
		const h = this.h.slice();
		for (let o = 0; o < pad.length; o += 64) block(h, this.w, pad, o);
		return [...h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
	}
}
