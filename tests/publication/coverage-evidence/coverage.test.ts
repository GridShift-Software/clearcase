// Synthetic only (U14). A run sealed by U3's real engine over node:sqlite, compared with an import link's coverage. The coverage, not the
// run's own count, is the expected set: every omission, extra, duplicate or wrong fact refuses.
import { describe, expect, it } from 'vitest';
import { createEvidenceEngine, d1EvidenceStore, type EvidenceBinding } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1EvidenceReader } from '../../../src/lib/publication/hosted/readiness-evidence.ts';
import { coverageFault } from '../../../src/lib/publication/hosted/coverage-evidence.ts';
import { d1, database } from '../evidence/harness.ts';
import { BOUND, PDF_RENDERED, UNCITED_MISSING, producerOf, runItems, type Item } from '../asset-policy/harness.ts';
import { CASE, CLIENT, hash } from '../signoff-root/harness.ts';

const BINDING: EvidenceBinding = { candidateId: 'candidate-1', generation: '1', clientId: CLIENT, caseId: CASE, resultsVersion: BOUND.resultsVersion, manifestSha256: BOUND.manifestSha256,
  validatorVersion: BOUND.validatorVersion, rendererVersion: 'renderer/1' };
const original = (assetId: string, sha256 = hash('a'), size = 10): Item => ({ key: `original/${assetId}`, observation: { kind: 'original', assetId, sha256, size, etag: `etag-${assetId}` } });
const byKey = (a: Item, b: Item) => (a.key < b.key ? -1 : 1);
/** The coverage the import recorded: SY-0005 mapped to submission asset `sub-a`, SY-0001 missing. */
const COVERAGE = { policy: 'exact-required-file-set/1', unavailableOriginals: [{ ref: UNCITED_MISSING.assetId, kind: 'missing' }],
  mappedOriginals: [{ packageRefs: [PDF_RENDERED.assetId], submissionAssetId: 'sub-a', path: 'Letters/A.pdf', sha256: hash('a'), size: 10 }] } as never;
const EXACT = [...runItems([UNCITED_MISSING, PDF_RENDERED]), original('sub-a')].sort(byKey);

async function fault(items: Item[], coverage = COVERAGE) {
  const adapter = d1(database());
  let now = 0;
  const engine = createEvidenceEngine({ binding: BINDING, store: d1EvidenceStore(adapter), producer: producerOf(items), clock: () => now, leaseId: 'builder', leaseMs: 1_000_000,
    bounds: { itemsPerStep: 500, bytesPerStep: 1 << 20 } });
  let root: string | null = null;
  for (let n = 0; n < 20 && !root; n++, now++) { const r = await engine.step(); if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind); }
  const count = (kind: string) => items.filter((i) => i.observation.kind === kind).length;
  return coverageFault(d1EvidenceReader(adapter), { clientId: CLIENT, caseId: CASE, candidateId: BINDING.candidateId, generation: '1', root: root!, resultsVersion: BOUND.resultsVersion, manifestSha256: BOUND.manifestSha256 },
    coverage, { original: count('original'), preview: count('preview'), warning: count('warning') }, BOUND);
}
const without = (key: string) => EXACT.filter((i) => i.key !== key);

describe('coverage of a sealed run against its link (U14)', () => {
  it('accepts exactly one original per mapped submission asset, a preview per present asset and the missing asset warned instead', async () => {
    expect(await fault(EXACT)).toBeNull();
  });
  it('refuses an omitted, an extra or a changed original', async () => {
    expect(await fault(without('original/sub-a'))).toBe('originals');
    expect(await fault([...EXACT, original('sub-b')].sort(byKey))).toBe('originals');
    expect(await fault([...without('original/sub-a'), original('sub-a', hash('b'))].sort(byKey))).toBe('originals');
    expect(await fault([...without('original/sub-a'), original('sub-a', hash('a'), 11)].sort(byKey))).toBe('originals');
  });
  it('refuses a present asset with no preview, and a preview for an asset the coverage does not list', async () => {
    expect(await fault(without(`preview/${PDF_RENDERED.assetId}`))).toBe('previews');
    expect(await fault([...EXACT, { key: 'preview/SY-9999', observation: { kind: 'preview', assetId: 'SY-9999', state: 'rendered' } }].sort(byKey))).toBe('previews');
  });
  it('refuses a missing-original warning for an asset the coverage maps, and a missing asset with neither warning nor preview', async () => {
    const mapped = { policy: 'exact-required-file-set/1', unavailableOriginals: [],
      mappedOriginals: [{ packageRefs: [PDF_RENDERED.assetId], submissionAssetId: 'sub-a', sha256: hash('a'), size: 10 }, { packageRefs: [UNCITED_MISSING.assetId], submissionAssetId: 'sub-m', sha256: hash('c'), size: 5 }] } as never;
    expect(await fault([...EXACT, original('sub-m', hash('c'), 5)].sort(byKey), mapped)).toBe('missing');
    const unwarned = EXACT.filter((i) => !(i.observation.kind === 'warning' && 'missing' in i.observation));
    expect(await fault(unwarned)).toBe('previews');
  });
});
