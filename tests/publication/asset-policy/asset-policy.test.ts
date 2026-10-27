import { describe, expect, it } from 'vitest';
import { ASSET_ACK_CODE, assetPolicyItems, decideAsset, missingAssetDiagnostic, missingOriginalAcknowledgement, missingOriginalFingerprint } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { checkEvidenceItem, missingOriginalsOf, type CheckedEvidenceItem } from '../../../src/lib/publication/hosted/rules.ts';
import { fingerprint } from '../../../src/lib/case-package/diagnostics.ts';
import { CASE, CLIENT, RV, hash } from '../signoff-root/harness.ts';
import { BOUND, CITED_MISSING, DOCX_NO_PREVIEW, DOCX_WITH_PREVIEW, EMBEDDED, PDF_RENDERED, UNCITED_MISSING, assetWorld, freshOf, runItems, type Item } from './harness.ts';

// Unit U10 (real-export design 3, ADR-0014 Proposed): the asset policy states. Four cases decide it: an uncited missing original, a cited
// missing original, an embedded asset and a docx without a preview. Only the first clears, and only after acknowledgement. The evidence is
// written by U3's real engine into the real tables; the controller, ledger and publisher are the real ones, as in U5's tests.
const REASON = 'The client confirmed these originals were never in the export.';
const ackFor = (items: readonly Item[], fresh: readonly string[], reason = REASON) => {
  const missing = items.flatMap((i) => (i.observation.missing ? [{ fingerprint: (i.observation as { fingerprint: string }).fingerprint, diagnostic: (i.observation.missing as { diagnostic: string }).diagnostic }] : []));
  return missingOriginalAcknowledgement(missing, new Set(fresh), reason);
};
const rest = (fresh: readonly string[], group: { fingerprints: readonly string[] }) => fresh.filter((f) => !group.fingerprints.includes(f));
const held = (reason: string) => ({ status: 422, body: { code: 'preview-not-ready', detail: [`failed:${reason}=1`] } });

describe('decisive: four assets, one clears', () => {
  it('an uncited missing original clears only after acknowledgement', async () => {
    const w = await assetWorld([UNCITED_MISSING, PDF_RENDERED]);
    const fresh = freshOf(w);
    // Two fresh warnings: the validator's own ASSET_MISSING_AT_BUILD and the policy's bound one. Neither is a blocker; both need a reason.
    expect(fresh).toHaveLength(2);
    const none = await w.signOff({ acknowledgements: [] });
    expect(none).toMatchObject({ status: 422, body: { code: 'ack-incomplete', missingCount: 2 } });
    const group = ackFor(w.items, fresh);
    expect(group.fingerprints.slice().sort()).toEqual(fresh.slice().sort());
    expect(await w.signOff({ acknowledgements: [{ ...group, fingerprints: [group.fingerprints[0]!] }] })).toMatchObject({ status: 422, body: { code: 'ack-incomplete', missingCount: 1 } });
    const signed = await w.signOff({ acknowledgements: [group] });
    expect(signed).toMatchObject({ status: 201, body: { state: 'signed-off' } });
    expect(w.pointer()).toBeNull();
    expect((await w.publish(signed.body.signoffId as string)).status).toBe(200);
  });

  it.each([
    ['a cited missing original', CITED_MISSING, 'supplied-references'],
    ['an embedded asset', EMBEDDED, 'embedded-not-extracted'],
    ['a docx without a preview', DOCX_NO_PREVIEW, 'preview-required'],
  ])('%s holds with its named reason, even with every warning acknowledged', async (_name, input, reason) => {
    const w = await assetWorld([input, PDF_RENDERED]);
    const fresh = freshOf(w);
    expect(await w.signOff({ acknowledgements: fresh.length ? [{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: fresh }] : [] })).toMatchObject(held(reason));
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('all four together hold with all three reasons named, and the uncited one is not among them', async () => {
    const w = await assetWorld([UNCITED_MISSING, CITED_MISSING, EMBEDDED, DOCX_NO_PREVIEW]);
    const blocked = await w.signOff({ acknowledgements: [{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: freshOf(w) }] });
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ code: 'preview-not-ready' });
    expect((blocked.body.detail as string[]).slice().sort()).toEqual(['failed:embedded-not-extracted=1', 'failed:preview-required=1', 'failed:supplied-references=1']);
  });

  it('an acknowledgement never turns a held asset into an observation: acknowledging the cited one changes nothing', async () => {
    const w = await assetWorld([CITED_MISSING]);
    const before = w.db.rows('SELECT item_key, item_json FROM pub_evidence_item ORDER BY item_key');
    expect(await w.signOff({ acknowledgements: [{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: freshOf(w) }] })).toMatchObject(held('supplied-references'));
    expect(w.db.rows('SELECT item_key, item_json FROM pub_evidence_item ORDER BY item_key')).toEqual(before);
  });
});

describe('the acknowledgement is recorded and replayed', () => {
  it('records its code, reason and fingerprints, audits the sign-off, and answers a replay with the same sign-off', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const group = ackFor(w.items, freshOf(w));
    const operationId = 'signoff-operation-replay0001';
    const first = await w.signOff({ operationId, acknowledgements: [group] });
    expect(first.status).toBe(201);
    const row = w.signoffRow(first.body.signoffId as string);
    const stored = JSON.parse(row.acknowledgements!) as { groups: { code: string; reason: string; fingerprints: string[] }[] };
    expect(stored.groups).toEqual([{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: group.fingerprints.slice().sort() }]);
    expect(w.events.filter((e) => e.action === 'publication.signoff')).toHaveLength(1);
    const again = await w.signOff({ operationId, acknowledgements: [group] });
    expect(again).toMatchObject({ status: 200, body: { signoffId: first.body.signoffId, state: 'signed-off' } });
    expect(w.db.rows('SELECT signoff_id FROM pub_signoff')).toHaveLength(1);
    expect(w.events.filter((e) => e.action === 'publication.signoff')).toHaveLength(1);
    // The same operation with another reason is a different request, never a replay.
    expect(await w.signOff({ operationId, acknowledgements: [{ ...group, reason: 'Another reason.' }] })).toMatchObject({ status: 409, body: { code: 'operation-reused' } });
  });

  it('refuses an acknowledgement without a reason', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const group = ackFor(w.items, freshOf(w), '   ');
    expect(await w.signOff({ acknowledgements: [group] })).toMatchObject({ status: 422, body: { code: 'ack-reason' } });
  });
});

describe('an acknowledgement does not carry over to a changed candidate', () => {
  const rebound = [
    ['another manifest', { ...BOUND, manifestSha256: hash('2') }],
    ['another results version', { ...BOUND, resultsVersion: `sha256:${hash('3')}` as typeof RV }],
    ['another validation', { ...BOUND, diagnosticsSha256: hash('4') }],
    ['another validator', { ...BOUND, validatorVersion: 'validator-2' }],
  ] as const;
  it.each(rebound)('%s gives the same asset a new fingerprint', (_name, other) => {
    const diagnostic = missingAssetDiagnostic(UNCITED_MISSING.assetId);
    expect(missingOriginalFingerprint(other, UNCITED_MISSING.assetId, diagnostic)).not.toBe(missingOriginalFingerprint(BOUND, UNCITED_MISSING.assetId, diagnostic));
    expect(missingOriginalFingerprint(BOUND, 'SY-0009', diagnostic)).not.toBe(missingOriginalFingerprint(BOUND, UNCITED_MISSING.assetId, diagnostic));
  });

  it('the old acknowledgement names fingerprints the new candidate does not hold, so sign-off refuses it', async () => {
    const old = await assetWorld([UNCITED_MISSING]);
    const stale = ackFor(old.items, freshOf(old));
    const now = await assetWorld([UNCITED_MISSING], { ...BOUND, diagnosticsSha256: hash('4') });
    const fresh = freshOf(now);
    const carried = await now.signOff({ acknowledgements: [stale] });
    expect(carried).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    expect(now.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
    // The validator's own warning is the same in both, so only the bound fingerprint differs; the current one is accepted.
    expect(fresh.filter((f) => stale.fingerprints.includes(f))).toHaveLength(1);
    expect((await now.signOff({ acknowledgements: [ackFor(now.items, fresh)] })).status).toBe(201);
  });
});

describe('the step decides each asset by the policy and only by it', () => {
  it('names the policy of every case', () => {
    expect(decideAsset(UNCITED_MISSING)).toEqual({ assetId: 'SY-0001', policy: 'not-supplied' });
    expect(decideAsset(CITED_MISSING)).toEqual({ assetId: 'SY-0002', policy: 'held', reason: 'supplied-references' });
    expect(decideAsset(EMBEDDED)).toEqual({ assetId: 'SY-0003.a1', policy: 'held', reason: 'embedded-not-extracted' });
    expect(decideAsset(DOCX_NO_PREVIEW)).toEqual({ assetId: 'SY-0004', policy: 'held', reason: 'preview-required' });
    expect(decideAsset(PDF_RENDERED)).toMatchObject({ policy: 'viewable' });
    expect(decideAsset(DOCX_WITH_PREVIEW)).toMatchObject({ policy: 'viewable' });
  });

  it('a file asset whose original is not in the case folder is held, never acknowledged: only a missing asset the converter recorded can be', () => {
    expect(decideAsset({ ...PDF_RENDERED, supplied: false, render: null })).toEqual({ assetId: 'SY-0005', policy: 'held', reason: 'supplied-references' });
    expect(decideAsset({ ...DOCX_NO_PREVIEW, supplied: false })).toEqual({ assetId: 'SY-0004', policy: 'held', reason: 'supplied-references' });
  });

  it('a docx whose preview is declared but not rendered is pending, never held for lacking one', () => {
    expect(decideAsset({ ...DOCX_WITH_PREVIEW, render: null })).toEqual({ assetId: 'SY-0006', policy: 'viewable', render: null });
    expect(assetPolicyItems([{ ...DOCX_WITH_PREVIEW, render: null }], { binding: BOUND, warningFingerprints: [] })).toEqual([
      { key: 'preview/SY-0006', observation: { kind: 'preview', assetId: 'SY-0006', state: 'pending' } }]);
  });

  it('keeps the render outcome of a viewable asset exactly, and leaves a not-supplied asset out of the preview set', () => {
    const failed = { ...PDF_RENDERED, render: { state: 'failed', reasonCode: 'render-timeout', stage: 'navigation' } } as const;
    const items = assetPolicyItems([failed, UNCITED_MISSING], { binding: BOUND, warningFingerprints: [missingAssetDiagnostic('SY-0001')] });
    expect(items.map((i) => i.key)).toEqual([expect.stringMatching(/^preview\/SY-0005$/), expect.stringMatching(/^warning\/[0-9a-f]{32}$/)]);
    expect(items[0]!.observation).toEqual({ kind: 'preview', assetId: 'SY-0005', state: 'failed', reasonCode: 'render-timeout', stage: 'navigation' });
    expect(items.some((i) => i.key === 'preview/SY-0001')).toBe(false);
  });

  it('refuses to build when the validation did not report the missing original it would acknowledge', () => {
    expect(() => assetPolicyItems([UNCITED_MISSING], { binding: BOUND, warningFingerprints: [] })).toThrow(/ASSET_MISSING_AT_BUILD/);
    expect(() => assetPolicyItems([UNCITED_MISSING], { binding: BOUND, warningFingerprints: ['0'.repeat(32)] })).toThrow();
  });

  it('derives the validator diagnostic the way the validator does', () => {
    expect(missingAssetDiagnostic('SY-0001')).toBe(fingerprint('ASSET_MISSING_AT_BUILD', { file: 'assets.json', pointer: '/assets/SY-0001/path', subject: 'SY-0001' }));
  });

  it('is built in ascending key order with one item per asset, whatever the input order', () => {
    const inputs = [DOCX_NO_PREVIEW, UNCITED_MISSING, EMBEDDED, PDF_RENDERED, CITED_MISSING];
    const keys = assetPolicyItems(inputs, { binding: BOUND, warningFingerprints: [missingAssetDiagnostic('SY-0001'), missingAssetDiagnostic('SY-0002')] }).map((i) => i.key);
    expect(keys).toEqual([...keys].sort());
    expect(assetPolicyItems([...inputs].reverse(), { binding: BOUND, warningFingerprints: [missingAssetDiagnostic('SY-0001'), missingAssetDiagnostic('SY-0002')] }).map((i) => i.key)).toEqual(keys);
    expect(() => assetPolicyItems([PDF_RENDERED, PDF_RENDERED], { binding: BOUND, warningFingerprints: [] })).toThrow(/twice/);
  });
});

describe('the rows the step writes are checked as the readiness and sign-off paths read them', () => {
  const bound = { clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: BOUND.manifestSha256 };
  const row = (item: Item, baseline: boolean | null) => ({ key: item.key, baseline, json: JSON.stringify({ input: { caseId: CASE, clientId: CLIENT, manifestSha256: BOUND.manifestSha256, rendererVersion: 'r/1', resultsVersion: RV, validatorVersion: 'validator-1' }, observation: item.observation }) });
  it('serves a held preview and a missing original, and lists the missing one for coverage', () => {
    const items = runItems([UNCITED_MISSING, EMBEDDED]);
    const checked = items.flatMap((i) => { const c = checkEvidenceItem(row(i, i.key.startsWith('warning/') ? false : null), bound); return c ? [c] : []; });
    expect(checked).toHaveLength(items.length);
    const missing = missingOriginalsOf(checked as CheckedEvidenceItem[]);
    expect(missing).toEqual([{ assetId: 'SY-0001', diagnostic: missingAssetDiagnostic('SY-0001'), fingerprint: missingOriginalFingerprint(BOUND, 'SY-0001', missingAssetDiagnostic('SY-0001')) }]);
    expect(checked.find((c) => c.key === 'preview/SY-0003.a1')!.observation).toMatchObject({ state: 'failed', reasonCode: 'embedded-not-extracted' });
  });
  it.each([
    ['a policy reason on a rendered preview', { kind: 'preview', assetId: 'a', state: 'rendered', reasonCode: 'preview-required' }, 'preview/a'],
    ['a policy reason on a pending preview', { kind: 'preview', assetId: 'a', state: 'pending', reasonCode: 'preview-required' }, 'preview/a'],
    ['a missing detail beside a meta one', { kind: 'warning', fingerprint: 'a'.repeat(32), missing: { assetId: 'a', diagnostic: 'b'.repeat(32) }, meta: { diagnostic: 'b'.repeat(32), subject: 's', carried: 1, derived: 2 } }, `warning/${'a'.repeat(32)}`],
    ['a missing detail naming its own fingerprint', { kind: 'warning', fingerprint: 'a'.repeat(32), missing: { assetId: 'a', diagnostic: 'a'.repeat(32) } }, `warning/${'a'.repeat(32)}`],
    ['a missing detail on an error', { kind: 'error', fingerprint: 'a'.repeat(32), missing: { assetId: 'a', diagnostic: 'b'.repeat(32) } }, `error/${'a'.repeat(32)}`],
    ['a missing detail with an extra key', { kind: 'warning', fingerprint: 'a'.repeat(32), missing: { assetId: 'a', diagnostic: 'b'.repeat(32), more: 1 } }, `warning/${'a'.repeat(32)}`],
    ['a missing detail with an unsafe asset id', { kind: 'warning', fingerprint: 'a'.repeat(32), missing: { assetId: '../x', diagnostic: 'b'.repeat(32) } }, `warning/${'a'.repeat(32)}`],
  ])('refuses %s', (_name, observation, key) => {
    expect(checkEvidenceItem(row({ key, observation }, key.startsWith('warning/') ? false : null), bound)).toBeNull();
  });
});
