// A store-only ZIP64 writer and reader small enough to stream on a Worker (GRS-109, P7). Each entry is a local header
// with the data-descriptor flag, its bytes, then a signed descriptor carrying the CRC-32 computed while streaming, so no
// entry is ever held whole. The central directory gives every entry its local-header offset, in a ZIP64 extra field when
// that offset passes 4 GiB, and the archive always ends with a ZIP64 end record, its locator and the classic end record.
// Entries stay under 4 GiB each (the largest v5 original is 247 MiB), so sizes are 32-bit; offsets and counts are not.

const TABLE = (() => {
	const t = new Uint32Array(8 * 256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n]! >>> 8) ^ t[t[(k - 1) * 256 + n]! & 0xff]!;
	return t;
})();

/** CRC-32 (IEEE), slicing by eight; pass the previous value to continue across chunks. */
export function crc32(bytes: Uint8Array, previous = 0): number {
	let c = ~previous >>> 0;
	let i = 0;
	const n = bytes.length;
	for (; i + 8 <= n; i += 8) {
		const lo = (c ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24))) >>> 0;
		c =
			TABLE[7 * 256 + (lo & 0xff)]! ^
			TABLE[6 * 256 + ((lo >>> 8) & 0xff)]! ^
			TABLE[5 * 256 + ((lo >>> 16) & 0xff)]! ^
			TABLE[4 * 256 + (lo >>> 24)]! ^
			TABLE[3 * 256 + bytes[i + 4]!]! ^
			TABLE[2 * 256 + bytes[i + 5]!]! ^
			TABLE[256 + bytes[i + 6]!]! ^
			TABLE[bytes[i + 7]!]!;
	}
	for (; i < n; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return ~c >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1 January 1980: entries carry no host time
const FLAGS = 0x0008 | 0x0800; // data descriptor follows; names are UTF-8
const MAX32 = 0xffffffff;

const name = (s: string) => new TextEncoder().encode(s);

export const localHeaderSize = (path: string) => 30 + name(path).length;
export const DESCRIPTOR_SIZE = 16;

export function localHeader(path: string): Uint8Array {
	const n = name(path);
	const b = new Uint8Array(30 + n.length);
	const v = new DataView(b.buffer);
	v.setUint32(0, 0x04034b50, true);
	v.setUint16(4, 20, true);
	v.setUint16(6, FLAGS, true);
	v.setUint16(8, 0, true); // stored
	v.setUint16(10, 0, true);
	v.setUint16(12, DOS_DATE, true);
	// CRC and sizes are zero here and follow in the descriptor (APPNOTE 4.4.4)
	v.setUint16(26, n.length, true);
	v.setUint16(28, 0, true);
	b.set(n, 30);
	return b;
}

export function descriptor(crc: number, size: number): Uint8Array {
	const b = new Uint8Array(DESCRIPTOR_SIZE);
	const v = new DataView(b.buffer);
	v.setUint32(0, 0x08074b50, true);
	v.setUint32(4, crc, true);
	v.setUint32(8, size, true);
	v.setUint32(12, size, true);
	return b;
}

export type Entry = { path: string; crc: number; size: number; offset: number };

function centralEntry(e: Entry): Uint8Array {
	const n = name(e.path);
	const big = e.offset >= MAX32;
	const b = new Uint8Array(46 + n.length + (big ? 12 : 0));
	const v = new DataView(b.buffer);
	v.setUint32(0, 0x02014b50, true);
	v.setUint16(4, 45, true);
	v.setUint16(6, big ? 45 : 20, true);
	v.setUint16(8, FLAGS, true);
	v.setUint16(10, 0, true);
	v.setUint16(12, 0, true);
	v.setUint16(14, DOS_DATE, true);
	v.setUint32(16, e.crc, true);
	v.setUint32(20, e.size, true);
	v.setUint32(24, e.size, true);
	v.setUint16(28, n.length, true);
	v.setUint16(30, big ? 12 : 0, true);
	v.setUint32(42, big ? MAX32 : e.offset, true);
	b.set(n, 46);
	if (big) {
		v.setUint16(46 + n.length, 0x0001, true);
		v.setUint16(48 + n.length, 8, true);
		v.setBigUint64(50 + n.length, BigInt(e.offset), true);
	}
	return b;
}

/** The central directory, the ZIP64 end record and locator, and the end record, for entries written from offset 0. */
export function trailer(entries: Entry[], at: number): Uint8Array {
	const parts = entries.map(centralEntry);
	const cdSize = parts.reduce((s, p) => s + p.length, 0);
	const end = new Uint8Array(56 + 20 + 22);
	const v = new DataView(end.buffer);
	const count = BigInt(entries.length);
	v.setUint32(0, 0x06064b50, true);
	v.setBigUint64(4, 44n, true);
	v.setUint16(12, 45, true);
	v.setUint16(14, 45, true);
	v.setBigUint64(24, count, true);
	v.setBigUint64(32, count, true);
	v.setBigUint64(40, BigInt(cdSize), true);
	v.setBigUint64(48, BigInt(at), true);
	v.setUint32(56, 0x07064b50, true);
	v.setBigUint64(64, BigInt(at + cdSize), true);
	v.setUint32(72, 1, true);
	v.setUint32(76, 0x06054b50, true);
	v.setUint16(84, Math.min(entries.length, 0xffff), true);
	v.setUint16(86, Math.min(entries.length, 0xffff), true);
	v.setUint32(88, Math.min(cdSize, MAX32), true);
	v.setUint32(92, at >= MAX32 ? MAX32 : at, true);
	const out = new Uint8Array(cdSize + end.length);
	let o = 0;
	for (const p of parts) (out.set(p, o), (o += p.length));
	out.set(end, o);
	return out;
}

/** Where the central directory is, from the archive's last bytes (`tail` ends at the archive's end). */
export function locate(tail: Uint8Array): { count: number; size: number; offset: number } {
	const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let i = tail.length - 22; i >= 20 + 56; i--) {
		if (v.getUint32(i, true) !== 0x06054b50) continue;
		if (v.getUint32(i - 20, true) !== 0x07064b50) throw new Error('zip: no ZIP64 end locator before the end record');
		const z = i - 20 - 56;
		if (v.getUint32(z, true) !== 0x06064b50) throw new Error('zip: the ZIP64 end record is not where its locator says');
		return { count: Number(v.getBigUint64(z + 32, true)), size: Number(v.getBigUint64(z + 40, true)), offset: Number(v.getBigUint64(z + 48, true)) };
	}
	throw new Error('zip: no end record');
}

export function centralDirectory(cd: Uint8Array, count: number): Entry[] {
	const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
	const out: Entry[] = [];
	let o = 0;
	for (let k = 0; k < count; k++) {
		if (v.getUint32(o, true) !== 0x02014b50) throw new Error(`zip: central entry ${k} has no signature`);
		if (v.getUint16(o + 10, true) !== 0) throw new Error(`zip: central entry ${k} is compressed`);
		const nameLen = v.getUint16(o + 28, true);
		const extraLen = v.getUint16(o + 30, true);
		const commentLen = v.getUint16(o + 32, true);
		const size = v.getUint32(o + 24, true);
		if (size === MAX32 || v.getUint32(o + 20, true) !== size) throw new Error(`zip: central entry ${k} has a size this reader does not take`);
		let offset = v.getUint32(o + 42, true);
		const path = new TextDecoder('utf-8', { fatal: true }).decode(cd.subarray(o + 46, o + 46 + nameLen));
		if (offset === MAX32) {
			let x = o + 46 + nameLen;
			const stop = x + extraLen;
			let found = false;
			for (; x + 4 <= stop; x += 4 + v.getUint16(x + 2, true)) {
				if (v.getUint16(x, true) === 0x0001 && v.getUint16(x + 2, true) === 8) ((offset = Number(v.getBigUint64(x + 4, true))), (found = true));
			}
			if (!found) throw new Error(`zip: central entry ${k} lacks its ZIP64 offset`);
		}
		out.push({ path, crc: v.getUint32(o + 16, true), size, offset });
		o += 46 + nameLen + extraLen + commentLen;
	}
	if (o !== cd.length) throw new Error('zip: the central directory has bytes after its last entry');
	return out;
}

/** Checks the local header at the start of `head` names `path` and has no extra field; returns its length. */
export function checkLocal(head: Uint8Array, path: string): number {
	const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const n = name(path);
	if (v.getUint32(0, true) !== 0x04034b50 || v.getUint16(8, true) !== 0 || v.getUint16(26, true) !== n.length || v.getUint16(28, true) !== 0) throw new Error(`zip: the local header of ${path} is not this writer's`);
	for (let i = 0; i < n.length; i++) if (head[30 + i] !== n[i]) throw new Error(`zip: the local header names another entry than ${path}`);
	return 30 + n.length;
}
