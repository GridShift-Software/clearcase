const TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
	return t;
})();

export function crc32(u8: Uint8Array): number {
	let c = -1;
	for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

export function storedZip(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const u16 = (n: number) => [n & 255, (n >> 8) & 255];
	const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
	const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
	let off = 0, cdlen = 0;
	for (const f of files) {
		const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
		const lh = new Uint8Array([80, 75, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nm.length), ...u16(0)]);
		chunks.push(lh, nm, f.data);
		const hd = new Uint8Array([80, 75, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]);
		central.push(hd, nm);
		cdlen += hd.length + nm.length;
		off += lh.length + nm.length + sz;
	}
	const end = new Uint8Array([80, 75, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdlen), ...u32(off), ...u16(0)]);
	const all = [...chunks, ...central, end];
	const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
	let p = 0;
	for (const c of all) { out.set(c, p); p += c.length; }
	return out;
}
