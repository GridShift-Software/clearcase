import { describe, expect, it } from 'vitest';
import { ASSET_ACK_CODE, assetPolicyItems, missingAssetDiagnostic, missingOriginalAcknowledgement, missingOriginalFingerprint } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { checkEvidenceItem, missingOriginalsOf, type CheckedEvidenceItem } from '../../../src/lib/publication/hosted/rules.ts';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { fingerprint } from '../../../src/lib/case-package/diagnostics.ts';
import { worldV2 } from '../readiness-v2/harness.ts';
import { CASE, CLIENT, RV, hash, world } from '../signoff-root/harness.ts';
import { BOUND, UNCITED_MISSING, FIXTURE_BOUND, assetWorld, buildAssetEvidence, freshOf, producerOf, runItems, type Item } from './harness.ts';

// U10 fix round 1 (review probes 1 and 2). A missing-original exception is accepted only when its diagnostic is ASSET_MISSING_AT_BUILD for exactly
// that asset, the validator's own warning is in the run, and its fingerprint is the one recomputed from the current candidate and validation.
const REASON = 'Old acknowledgement, not re-reviewed for the current candidate.';
const bound = { clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: BOUND.manifestSha256 };
const rowOf = (item: Item, baseline: boolean | null) => ({ key: item.key, baseline, json: JSON.stringify({ input: { caseId: CASE, clientId: CLIENT, manifestSha256: BOUND.manifestSha256, rendererVersion: 'r/1', resultsVersion: RV, validatorVersion: 'validator-1' }, observation: item.observation }) });
const checkedOf = (items: readonly Item[]): CheckedEvidenceItem[] => items.filter((i) => i.key.startsWith('warning/')).map((i) => checkEvidenceItem(rowOf(i, false), bound)!);

describe('probe 1: a fingerprint bound to another candidate or validation is not accepted under the current one', () => {
  const stale = [
    ['manifest', { ...BOUND, manifestSha256: hash('2') }],
    ['results version', { ...BOUND, resultsVersion: `sha256:${hash('3')}` }],
    ['diagnostics', { ...BOUND, diagnosticsSha256: hash('4') }],
    ['validator', { ...BOUND, validatorVersion: 'validator-old' }],
  ] as const;
  it.each(stale)('a stale %s: the extractor yields nothing and sign-off is refused, so nothing is published', async (_name, old) => {
    const w = await assetWorld([UNCITED_MISSING], old);
    expect(missingOriginalsOf(checkedOf(w.items), BOUND)).toBeNull();
    const diagnostic = missingAssetDiagnostic(UNCITED_MISSING.assetId);
    const group = missingOriginalAcknowledgement([{ diagnostic, fingerprint: missingOriginalFingerprint(old, UNCITED_MISSING.assetId, diagnostic) }], new Set(freshOf(w)), REASON);
    expect(group.code).toBe(ASSET_ACK_CODE);
    const signed = await w.signOff({ acknowledgements: [group] });
    expect(signed.status).toBe(503);
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
    expect(w.pointer()).toBeNull();
  });

  it('the current binding is accepted and yields the exception', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const diagnostic = missingAssetDiagnostic(UNCITED_MISSING.assetId);
    expect(missingOriginalsOf(checkedOf(w.items), BOUND)).toEqual([{ assetId: 'SY-0001', diagnostic, fingerprint: missingOriginalFingerprint(BOUND, 'SY-0001', diagnostic) }]);
  });

  it('readiness refuses a page that serves a missing original bound to another validation', async () => {
    const w = worldV2(await buildAssetEvidence([UNCITED_MISSING], { ...FIXTURE_BOUND, diagnosticsSha256: hash('4') }), { pageSize: 100 });
    const response = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }));
    expect(response.status).toBe(503);
  });
});

describe('probe 2: a warning tagged missing but naming another diagnostic is not an exception', () => {
  const unrelated = fingerprint('TEXT_NONE', { subject: 'SY-0001' });
  const policy = 'a'.repeat(32);
  const items: Item[] = [
    { key: 'section/meta', observation: { kind: 'section', key: 'meta', state: 'integrity-verified' } },
    { key: `warning/${policy}`, observation: { kind: 'warning', fingerprint: policy, missing: { assetId: 'SY-0001', diagnostic: unrelated } } },
  ];
  it('is not returned for coverage, and sign-off refuses the run', async () => {
    const w = await world({ spec: { previews: 0, warnings: 0 }, baseline: 0, producer: producerOf(items) });
    expect(missingOriginalsOf(checkedOf(items), BOUND)).toBeNull();
    const signed = await w.signOff({ acknowledgements: [{ code: ASSET_ACK_CODE, reason: 'This is not a missing-original validation diagnostic.', fingerprints: [policy] }] });
    expect(signed.status).toBe(503);
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('the canonical diagnostic of another asset is no better, and neither is a canonical one the validator never reported', async () => {
    const other = missingAssetDiagnostic('SY-0002');
    const fp = missingOriginalFingerprint(BOUND, 'SY-0001', other);
    const swapped = [{ key: `warning/${fp}`, observation: { kind: 'warning', fingerprint: fp, missing: { assetId: 'SY-0001', diagnostic: other } } }, { key: `warning/${other}`, observation: { kind: 'warning', fingerprint: other } }];
    expect(missingOriginalsOf(checkedOf(swapped), BOUND)).toBeNull();
    const own = missingAssetDiagnostic('SY-0001'), ownFp = missingOriginalFingerprint(BOUND, 'SY-0001', own);
    const unreported = [{ key: `warning/${ownFp}`, observation: { kind: 'warning', fingerprint: ownFp, missing: { assetId: 'SY-0001', diagnostic: own } } }];
    expect(missingOriginalsOf(checkedOf(unreported), BOUND)).toBeNull();
    expect(() => assetPolicyItems([UNCITED_MISSING], { binding: BOUND, warningFingerprints: [] })).toThrow(/ASSET_MISSING_AT_BUILD/);
  });

  it('one asset twice is refused', () => {
    const items2 = runItems([UNCITED_MISSING]);
    const dup = [...items2, ...items2.filter((i) => i.key.startsWith('warning/') && (i.observation as { missing?: unknown }).missing)];
    expect(missingOriginalsOf(checkedOf(dup), BOUND)).toBeNull();
  });
});

describe('the acknowledgement of a missing original must be under its own code', () => {
  it('names the bound fingerprint under another code and sign-off refuses it', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const fresh = freshOf(w);
    const signed = await w.signOff({ acknowledgements: [{ code: 'DS_UNSUPPORTED_FIELD', reason: 'Wrong group.', fingerprints: fresh }] });
    expect(signed).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
  });
});
