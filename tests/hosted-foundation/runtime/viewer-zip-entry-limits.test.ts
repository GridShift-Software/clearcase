// The viewer reference extractor's per-member cap is on the bytes it would accept, whatever the header declares (PR #75
// review, GRS-97): a stored member can declare size 1 and carry far more. Small synthetic ZIPs under a small cap, in the
// ZIP writer the harness's own fixtures use; the 64 MiB fixture the browser checks open is archive/stored-lying-size.zip.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs
import { extractEntry, listZip } from '../../viewer-evaluation/harness/shared/formats.mjs';
// @ts-expect-error plain .mjs
import { buildZip, crc32 } from '../../viewer-evaluation/fixtures/lib/zip.mjs';

const limits = { maxEntries: 10, maxEntryBytes: 8, maxTotalBytes: 1 << 20, maxDepth: 3 };
const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => 65 + (i % 26));
const extract = (member: Record<string, unknown>, cap = limits) => {
	const zip = buildZip([{ name: 'm.bin', ...member }]);
	const { error, entries } = listZip(zip, cap);
	expect(error).toBeNull();
	return { entry: entries[0], result: extractEntry(zip, entries[0], cap) };
};

describe('the stored branch of the reference extractor applies the actual-byte cap', () => {
	it('a stored member declaring size 1 but carrying 64 bytes is refused under an 8-byte cap, as the lying-size deflate member is', () => {
		const raw = payload(64);
		const { entry, result } = extract({ method: 0, raw, size: 1, crc: crc32(raw) });
		expect(entry.problems).toEqual([]); // the listing alone cannot tell: the declared size is within the cap
		expect(result).toMatchObject({ ok: false, reason: 'expansion-limit-exceeded', expandedAtStop: 64 });
		expect(result.bytes).toBeUndefined();
	});

	it('a stored member whose declared size and stored length disagree is refused even when both are under the cap', () => {
		const raw = payload(4);
		const { result } = extract({ method: 0, raw, size: 1, crc: crc32(raw) });
		expect(result).toMatchObject({ ok: false, reason: 'size-mismatch' });
		expect(result.bytes).toBeUndefined();
	});

	it('a stored member whose bytes are exactly the cap is accepted with its CRC and size agreeing', () => {
		const raw = payload(8);
		const { result } = extract({ method: 0, raw, size: 8, crc: crc32(raw) });
		expect(result.ok).toBe(true);
		expect(result.bytes).toEqual(raw);
	});

	it('a stored member declaring more than the cap is still listed with declared-size-over-limit', () => {
		const raw = payload(64);
		const { entry, result } = extract({ method: 0, raw, size: 64, crc: crc32(raw) });
		expect(entry.problems).toEqual(['declared-size-over-limit']);
		expect(result).toMatchObject({ ok: false, reason: 'declared-size-over-limit' });
	});

	it('the deflate member declaring size 1 but inflating to 64 bytes is refused under the same cap', () => {
		const data = payload(64);
		const { result } = extract({ method: 8, raw: deflateRawSync(data), size: 1, crc: crc32(data) });
		expect(result).toMatchObject({ ok: false, reason: 'expansion-limit-exceeded' });
	});

	it('a nested stored ZIP is extracted under the same cap as any other member', () => {
		const inner = buildZip([{ name: 'inner.txt', data: 'NESTED' }]);
		const { result } = extract({ method: 0, raw: inner, size: 1, crc: crc32(inner) }, { ...limits, maxEntryBytes: 16 });
		expect(result).toMatchObject({ ok: false, reason: 'expansion-limit-exceeded' });
	});
});
