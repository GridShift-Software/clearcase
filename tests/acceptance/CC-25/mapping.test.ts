// PR #76 review, GRS-24 item 3: a source row that maps to another valid original, or to one of another size, fails the
// contract; the legitimate spellings of a locator are accounted for by name. Rows, assets and originals are invented.
import { describe, expect, it } from 'vitest';
import { mapOriginals, type IndexedAsset, type SourceRow, type VerifiedOriginal } from './mapping.ts';

const ORIGINALS: Record<string, VerifiedOriginal> = {
  'A/expected.txt': { path: 'A/expected.txt', sha256: 'e'.repeat(64), size: 10 },
  'A/wrong.txt': { path: 'A/wrong.txt', sha256: 'f'.repeat(64), size: 20 },
  'A/with space.txt': { path: 'A/with space.txt', sha256: 'd'.repeat(64), size: 5 },
};
/** One source row whose indexed asset is `asset`, verified against the original the reader holds at `original`. */
function run(row: Partial<SourceRow>, asset: Partial<IndexedAsset>, original: string | null = asset.path ?? 'A/expected.txt') {
  const a: IndexedAsset = { kind: 'file', path: 'A/expected.txt', size: 10, sha256: 'e'.repeat(64), ...asset };
  const o = original ? ORIGINALS[original] : undefined;
  return mapOriginals([{ ref: 'OD-001', url: './A/expected.txt', declaredSize: 10, ...row }], { 'OD-001': a }, () => (o ? { ...o, sha256: a.sha256 ?? o.sha256, size: a.size ?? o.size } : undefined));
}

describe('mapOriginals', () => {
  it('passes a row whose source locator and size agree with the indexed, verified original (positive control)', () => {
    const r = run({}, {});
    expect(r.problems).toEqual([]);
    expect(r.mapping).toMatchObject({ file: 1, verified: 1, pathFromSourceUrl: 1, pathOther: 0, sizeAgrees: 1, sizeDiffers: 0, realPathDiffers: 0 });
  });

  it('passes a percent-encoded locator for a path with a space', () => {
    expect(run({ url: './A/with%20space.txt', declaredSize: 5 }, { path: 'A/with space.txt', size: 5, sha256: 'd'.repeat(64) }).problems).toEqual([]);
  });

  it('fails a row mapped to another existing, verified original of the right size', () => {
    const r = run({}, { path: 'A/wrong.txt', size: 10, sha256: 'f'.repeat(64) });
    expect(r.problems).not.toEqual([]);
    expect(r.mapping.pathOther).toBe(1);
  });

  it('fails a row mapped to another existing, verified original of another size, naming both mismatches', () => {
    const r = run({}, { path: 'A/wrong.txt', size: 20, sha256: 'f'.repeat(64) });
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
    expect(r.mapping).toMatchObject({ pathOther: 1, sizeDiffers: 1 });
  });

  it('fails a row whose declared size differs from the indexed original at the same path', () => {
    const r = run({ declaredSize: 11 }, {});
    expect(r.problems).not.toEqual([]);
    expect(r.mapping.sizeDiffers).toBe(1);
  });

  it('fails a row whose source locator is missing or is not a "./" locator', () => {
    expect(run({ url: undefined }, {}).problems).not.toEqual([]);
    expect(run({ url: 'A/expected.txt' }, {}).problems).not.toEqual([]);
  });

  it('fails when the reader holds the original at another path than the index names', () => {
    const r = run({}, {}, 'A/wrong.txt');
    expect(r.problems).not.toEqual([]);
    expect(r.mapping.realPathDiffers).toBe(1);
  });

  it('still fails an indexed original the reader cannot verify, and a row with no asset', () => {
    expect(run({}, {}, null).problems).not.toEqual([]);
    expect(mapOriginals([{ ref: 'OD-009', url: './A/expected.txt', declaredSize: 10 }], {}, () => undefined).problems).not.toEqual([]);
  });

  it('accounts a locator with a fragment, and a source that declares no size, by name instead of failing', () => {
    const frag = run({ url: './A/expected.txt#page=2' }, {});
    expect(frag.problems).toEqual([]);
    expect(frag.mapping).toMatchObject({ pathNormalised: 1, pathOther: 0 });
    const noSize = run({ declaredSize: undefined }, {});
    expect(noSize.problems).toEqual([]);
    expect(noSize.mapping).toMatchObject({ sizeUndeclared: 1, sizeDiffers: 0 });
  });

  it('fails a declared size that is not a number', () => {
    expect(run({ declaredSize: '10' }, {}).problems).not.toEqual([]);
  });

  it('does not count missing or embedded assets as mismatches', () => {
    const r = mapOriginals([{ ref: 'OD-001', url: './A/gone.txt', declaredSize: 3 }], { 'OD-001': { kind: 'missing', path: 'A/gone.txt' }, 'OD-001.a1': { kind: 'embedded' } }, () => undefined);
    expect(r.problems).toEqual([]);
    expect(r.mapping).toMatchObject({ missing: 1, embedded: 1 });
  });
});
