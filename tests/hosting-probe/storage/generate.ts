// The POC-scale synthetic corpus of the storage probe (GRS-109): the counts and byte sizes of the v5 sample, never its
// content. Every number below is an aggregate the GRS-95 research measured on the local v5 sample (counts, byte totals and
// quantiles keyed by kind, no paths, names or values); every byte the probe stores is generated here from a seed.
//
//   bun generate.ts [--seed S] [--scale poc|smoke]   # prints the plan's aggregates as JSON
//
// `poc` is the evidence scale. `smoke` keeps the shapes with small counts and bytes, for working on the probe only; a
// smoke summary is never evidence.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const KiB = 1024;
const MiB = KiB * KiB;

/** The v5 aggregates (GRS-95, "Workload, measured as aggregates only"). */
export const V5 = {
	originals: { count: 1662, bytes: 3_211_390_882, p50: 205 * KiB, p90: Math.round(1.1 * MiB), p99: Math.round(31.5 * MiB), max: 258_590_305, over32MiB: 17, over100MiB: 7 },
	package: { files: 37, bytes: 6_249_551, largest: { 'datasets/chronology.json': 1_827_097, 'datasets/bundles.json': 1_613_368, 'datasets/caselines-index.json': 1_188_230, 'assets.json': 798_849 }, othersUnder: 333_000 },
	list: { rows: 1689, bytes: 1_509_878 },
	documents: { rows: 1689, p50: 1287, p99: 3093, max: 4617, bytes: 2_342_785 },
	assets: { rows: 3054, files: 1746, embedded: 1308 },
	seeds: { rows: 7 },
	/** Share of original files by kind (PDF 1,161, RFC 822 467, Outlook MSG 89, other 29 of 1,746 files). */
	kinds: [
		['application/pdf', 'pdf', 1161],
		['message/rfc822', 'eml', 467],
		['application/vnd.ms-outlook', 'msg', 89],
		['application/octet-stream', 'bin', 29],
	] as const,
} as const;

export type Scale = 'poc' | 'smoke';
export type OriginalPlan = { index: number; assetId: string; size: number; mediaType: string; filename: string };
export type FilePlan = { path: string; size: number };
export type Plan = {
	seed: string;
	scale: Scale;
	caseId: string;
	originals: OriginalPlan[];
	packageFiles: FilePlan[];
	listRows: number;
	listBytes: number;
	documentSizes: number[];
	assets: { assetId: string; original: number | null }[];
	seeds: number;
};

/** A seeded xorshift128 stream; the same seed gives the same numbers on every host. */
export function random(seed: string): () => number {
	const h = createHash('sha256').update(seed).digest();
	let [a, b, c, d] = [h.readUInt32LE(0) | 1, h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)];
	return () => {
		const t = a ^ (a << 11);
		[a, b, c] = [b, c, d];
		d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
		return d / 0x1_0000_0000;
	};
}

/** Sorted original sizes: log-linear between the measured quantiles, the middle band shaped so the total is exact. */
export function originalSizes(n: number, total: number, q: { p50: number; p90: number; p99: number; max: number; over32MiB: number; over100MiB: number }): number[] {
	const curve = (midShape: number) => {
		const anchors: [number, number][] = [[0, 2048], [(n - 1) * 0.5, q.p50], [(n - 1) * 0.9, q.p90], [(n - 1) * 0.99, q.p99], [n - q.over32MiB, 32 * MiB + 1], [n - q.over100MiB - 1, 100 * MiB], [n - q.over100MiB, 100 * MiB + 1], [n - 1, q.max]];
		const out: number[] = [];
		for (let r = 0; r < n; r++) {
			let i = 0;
			while (anchors[i + 1]![0] < r) i++;
			const [r0, s0] = anchors[i]!;
			const [r1, s1] = anchors[i + 1]!;
			let t = (r - r0) / (r1 - r0);
			t = i >= 4 ? t * t : i >= 2 ? t ** midShape : t;
			out.push(Math.round(Math.exp(Math.log(s0) + t * (Math.log(s1) - Math.log(s0)))));
		}
		return out;
	};
	let [lo, hi] = [0.5, 3];
	for (let k = 0; k < 80; k++) {
		const mid = (lo + hi) / 2;
		if (curve(mid).reduce((x, y) => x + y, 0) > total) lo = mid;
		else hi = mid;
	}
	const sizes = curve(lo);
	sizes[Math.floor(n * 0.72)]! += total - sizes.reduce((x, y) => x + y, 0); // the rounding residual, a few bytes
	return sizes;
}

/** Document row sizes: linear between the measured quantiles, the lower half shifted so the total is exact. */
function documentSizes(n: number, q: { p50: number; p99: number; max: number; bytes: number }): number[] {
	const anchors: [number, number][] = [[0, 640], [(n - 1) * 0.5, q.p50], [(n - 1) * 0.99, q.p99], [n - 1, q.max]];
	const sizes = Array.from({ length: n }, (_, r) => {
		let i = 0;
		while (anchors[i + 1]![0] < r) i++;
		const [r0, s0] = anchors[i]!;
		const [r1, s1] = anchors[i + 1]!;
		return Math.round(s0 + ((r - r0) / (r1 - r0)) * (s1 - s0));
	});
	const half = Math.floor(n / 2);
	const residual = q.bytes - sizes.reduce((x, y) => x + y, 0);
	for (let r = 0; r < half; r++) sizes[r]! += Math.trunc(residual / half) + (r < Math.abs(residual % half) ? Math.sign(residual) : 0);
	return sizes;
}

function shuffle<T>(items: T[], next: () => number): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[items[i], items[j]] = [items[j]!, items[i]!];
	}
	return items;
}

export function plan(seed: string, scale: Scale): Plan {
	const next = random(`${seed}/plan`);
	const smoke = scale === 'smoke';
	const o = V5.originals;
	const sizes = smoke ? originalSizes(24, 24 * 300 * KiB, { p50: 64 * KiB, p90: 512 * KiB, p99: 1 * MiB, max: 3 * MiB, over32MiB: 0, over100MiB: 0 }).map((s) => Math.max(s, 300)) : originalSizes(o.count, o.bytes, o);
	const kinds = V5.kinds.flatMap(([mediaType, ext, count]) => Array.from({ length: count }, () => ({ mediaType, ext })));
	const originals = shuffle(sizes.slice(), next).map((size, index) => {
		const kind = kinds[Math.floor(next() * kinds.length)]!;
		const assetId = `orig-${String(index + 1).padStart(4, '0')}`;
		return { index, assetId, size, mediaType: kind.mediaType, filename: `synthetic-${assetId}.${kind.ext}` };
	});
	const p = V5.package;
	const fixed = Object.entries(p.largest).map(([path, size]) => ({ path, size }));
	const others = p.files - fixed.length;
	const rest = p.bytes - fixed.reduce((x, f) => x + f.size, 0);
	const largestOther = 332_000;
	const small = Math.floor((rest - largestOther) / (others - 1));
	const packageFiles: FilePlan[] = [{ path: 'manifest.json', size: rest - largestOther - small * (others - 2) }, { path: 'datasets/dataset-01.json', size: largestOther }, ...Array.from({ length: others - 2 }, (_, i) => ({ path: `datasets/dataset-${String(i + 2).padStart(2, '0')}.json`, size: small })), ...fixed];
	const scaleDown = (f: FilePlan) => (smoke ? { path: f.path, size: Math.max(256, Math.round(f.size / 64)) } : f);
	const docs = smoke ? 40 : V5.documents.rows;
	const assetFiles = smoke ? 30 : V5.assets.files;
	const assetEmbedded = smoke ? 20 : V5.assets.embedded;
	const assets = [
		...Array.from({ length: assetFiles }, (_, i) => ({ assetId: `asset-${String(i + 1).padStart(4, '0')}`, original: i < originals.length ? i : Math.floor(next() * originals.length) })),
		...Array.from({ length: assetEmbedded }, (_, i) => ({ assetId: `asset-e${String(i + 1).padStart(4, '0')}`, original: null })),
	];
	return {
		seed,
		scale,
		caseId: 'case-synthetic-1',
		originals,
		packageFiles: packageFiles.map(scaleDown),
		listRows: docs,
		listBytes: smoke ? 40 * 894 : V5.list.bytes,
		documentSizes: smoke ? documentSizes(docs, { p50: 1287, p99: 3093, max: 4617, bytes: docs * 1387 }) : documentSizes(docs, V5.documents),
		assets,
		seeds: V5.seeds.rows,
	};
}

const enc = new TextEncoder();

/** Bytes of one original: a synthetic header, then seeded noise, exactly `size` bytes. */
export function originalBytes(p: Plan, o: OriginalPlan): Uint8Array {
	const out = new Uint8Array(o.size);
	const header = enc.encode(`SYNTHETIC ONLY: ClearCase storage probe original ${o.assetId}, seed ${p.seed}\n`);
	out.set(header.subarray(0, o.size));
	const words = new Uint32Array(out.buffer, 0, Math.floor(o.size / 4));
	const h = createHash('sha256').update(`${p.seed}/original/${o.index}`).digest();
	let [a, b, c, d] = [h.readUInt32LE(0) | 1, h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)];
	for (let i = Math.ceil(header.length / 4); i < words.length; i++) {
		const t = a ^ (a << 11);
		a = b;
		b = c;
		c = d;
		d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
		words[i] = d;
	}
	return out;
}

/** A JSON object of exactly `size` bytes: `{"synthetic":true,"name":…,"pad":"…"}`. */
export function paddedJson(name: string, size: number, extra: Record<string, unknown> = {}): string {
	const head = JSON.stringify({ synthetic: true, name, ...extra, pad: '' });
	const pad = size - head.length;
	if (pad < 0) throw new Error(`${name}: ${size} bytes is too small for its fields`);
	return `${head.slice(0, -2)}${'s'.repeat(pad)}"}`;
}

export const packageFileText = (f: FilePlan) => paddedJson(f.path, f.size);

/** The chronology list: `listRows` rows whose JSON is exactly `listBytes` bytes. */
export function listText(p: Plan): string {
	const per = Math.floor((p.listBytes - 2 - (p.listRows - 1)) / p.listRows);
	const rows = Array.from({ length: p.listRows }, (_, i) => paddedJson(`S-${String(i + 1).padStart(4, '0')}`, per));
	const short = p.listBytes - (2 + (p.listRows - 1) + per * p.listRows);
	rows[0] = paddedJson('S-0001', per + short);
	return `[${rows.join(',')}]`;
}

/** The read model rows the projector would write: documents (sized as v5's), assets and seeds. */
export function readModel(p: Plan, sha256Of: (index: number) => string) {
	const documents = p.documentSizes.map((size, i) => {
		const ref = `S-${String(i + 1).padStart(4, '0')}`;
		return { ref, row_json: paddedJson(ref, size, { title: `Synthetic document ${i + 1}` }) };
	});
	const assets = p.assets.map((a) => (a.original === null ? { asset_id: a.assetId, sha256: null, size: null, kind: 'embedded' } : { asset_id: a.assetId, sha256: sha256Of(a.original), size: p.originals[a.original]!.size, kind: 'file' }));
	const seeds = Array.from({ length: p.seeds }, (_, i) => ({ seed_id: `seed-${i + 1}`, row_json: paddedJson(`seed-${i + 1}`, 200) }));
	return { documents, assets, seeds };
}

/** Quantiles and counts of a plan, to set beside V5 in the summary. */
export function aggregates(p: Plan) {
	const s = p.originals.map((o) => o.size).sort((x, y) => x - y);
	const q = (f: number) => s[Math.round((s.length - 1) * f)]!;
	return {
		originals: { count: s.length, bytes: s.reduce((x, y) => x + y, 0), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s.at(-1)!, over32MiB: s.filter((x) => x > 32 * MiB).length, over100MiB: s.filter((x) => x > 100 * MiB).length },
		package: { files: p.packageFiles.length, bytes: p.packageFiles.reduce((x, f) => x + f.size, 0) },
		list: { rows: p.listRows, bytes: p.listBytes },
		documents: { rows: p.documentSizes.length, bytes: p.documentSizes.reduce((x, y) => x + y, 0), max: Math.max(...p.documentSizes) },
		assets: { rows: p.assets.length, embedded: p.assets.filter((a) => a.original === null).length },
		seeds: { rows: p.seeds },
	};
}

if (process.argv[1] === import.meta.filename) {
	const { values } = parseArgs({ options: { seed: { type: 'string', default: 'grs-109' }, scale: { type: 'string', default: 'poc' } } });
	if (values.scale !== 'poc' && values.scale !== 'smoke') throw new Error('--scale is poc or smoke');
	console.log(JSON.stringify(aggregates(plan(values.seed, values.scale)), null, 2));
}
