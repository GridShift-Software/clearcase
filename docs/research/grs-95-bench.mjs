// GRS-95 synthetic measurement: the Worker-side CPU of the two hosted read shapes for the document list.
//   A  whole list from one blob (R2 object or KV value): decode + JSON.parse every row, filter, take one page
//   B  one page of pre-projected rows (D1 result rows): JSON.parse 50 row strings
//   V  verify-on-load as the app does it today: SHA-256 over the whole stored package
// Data is synthetic: rows have ChronologyListRow's shape (src/lib/local-case/model.ts) and the measured mean size of
// the real list (894 bytes per row; aggregate only). No case data is read. Storage and network time are NOT measured:
// this times only the JavaScript a Worker would run after the bytes arrive, in V8 (Node), as a proxy for workerd.
// Usage: node docs/research/grs-95-bench.mjs [samples=7]          (driver; one fresh process per sample)
//        node docs/research/grs-95-bench.mjs --one <arm> <rows>   (one sample)
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROW_BYTES = 894; // mean list-row JSON size of the real v5 list: 1,509,878 bytes / 1,689 rows
const PACKAGE_BYTES = 6_249_551; // real v5 package size (aggregate only)
const PAGE = 50;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const word = (r) => 'abcdefghijklmnopqrstuvwxyz'.slice(0, 3 + Math.floor(r() * 8));
const words = (r, n) => Array.from({ length: n }, () => word(r)).join(' ');

function rows(n) {
	const r = rng(95);
	const out = [];
	for (let i = 0; i < n; i++) {
		const row = {
			ref: `SY-${String(i + 1).padStart(4, '0')}`, ord: i, date: `20${10 + (i % 12)}-0${1 + (i % 9)}-1${i % 10}`, dateType: null, dateSource: null,
			docType: ['email', 'letter', 'invoice', 'contract'][i % 4], bundle: `B${i % 7}`, subject: words(r, 8), filename: `${word(r)}-${i}.pdf`,
			sender: `${word(r)}@example.test`, to: `${word(r)}@example.test`, excerpt: '', amount: i % 5 ? '' : `${(i * 37) % 99999}.00`,
			alsoIn: i % 11 ? [] : [`SY-${i}`], url: `synthetic/${i}`, textStatus: 'extracted', parentRef: null, file: 'present', preview: 'inline', attachments: i % 3,
		};
		const base = JSON.stringify(row).length;
		row.excerpt = words(r, 200).slice(0, Math.max(0, ROW_BYTES - base));
		out.push(row);
	}
	return out;
}

async function one(arm, n) {
	const enc = new TextEncoder();
	const list = rows(n);
	const expectHits = list.filter((x) => x.subject.includes('abcd')).length;
	let input;
	if (arm === 'A') input = enc.encode(JSON.stringify(list));
	else if (arm === 'B') input = list.slice(0, PAGE).map((x) => JSON.stringify(x));
	else input = new Uint8Array(PACKAGE_BYTES).map((_, i) => (i * 31) & 255);
	const heap0 = process.memoryUsage().heapUsed;
	const t0 = performance.now();
	let ok;
	if (arm === 'A') {
		const parsed = JSON.parse(new TextDecoder().decode(input));
		const hits = parsed.filter((x) => x.subject.includes('abcd'));
		const page = JSON.stringify(hits.slice(0, PAGE));
		ok = parsed.length === n && hits.length === expectHits && page.length > 0;
	} else if (arm === 'B') {
		const page = input.map((s) => JSON.parse(s));
		ok = page.length === Math.min(PAGE, n) && JSON.stringify(page).length > 0;
	} else {
		const d = new Uint8Array(await webcrypto.subtle.digest('SHA-256', input));
		ok = d.length === 32;
	}
	const ms = performance.now() - t0;
	const heapMiB = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
	return { arm, n, ms, heapMiB, ok, bytes: arm === 'A' ? input.length : arm === 'B' ? input.reduce((a, s) => a + s.length, 0) : input.length };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

if (process.argv[2] === '--one') {
	console.log(JSON.stringify(await one(process.argv[3], Number(process.argv[4]))));
} else {
	const samples = Number(process.argv[2] ?? 7);
	const self = fileURLToPath(import.meta.url);
	const plan = [];
	for (const n of [1689, 2131, 16890]) plan.push(['A', n], ['B', n]);
	plan.push(['V', 0]);
	const run = (arm, n) => JSON.parse(execFileSync(process.execPath, [self, '--one', arm, String(n)], { encoding: 'utf8' }));
	for (const [arm, n] of plan) run(arm, n); // warm-up: page cache, binary, not reported
	const res = new Map();
	for (let s = 0; s < samples; s++) for (const [arm, n] of s % 2 ? [...plan].reverse() : plan) { // alternate order each sample
		const r = run(arm, n);
		const k = `${arm}:${n}`;
		if (!res.has(k)) res.set(k, []);
		res.get(k).push(r);
	}
	for (const [k, rs] of res) {
		const ms = rs.map((r) => r.ms);
		console.log(JSON.stringify({ key: k, samples: rs.length, failures: rs.filter((r) => !r.ok).length, bytes: rs[0].bytes,
			medianMs: +med(ms).toFixed(2), minMs: +Math.min(...ms).toFixed(2), maxMs: +Math.max(...ms).toFixed(2), medianHeapMiB: +med(rs.map((r) => r.heapMiB)).toFixed(1) }));
	}
}
