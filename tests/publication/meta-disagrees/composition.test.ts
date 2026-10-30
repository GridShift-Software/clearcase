import { describe, expect, it } from 'vitest';
import { metaEvidenceItems, metaSectionV2, META_DISAGREEMENT_CODE } from '../../../src/lib/case-package/meta-integrity.ts';
import { checkEvidenceItem, metaDisagreementsOf, signoffBlockerV2, type AcknowledgementGroup, type CheckedEvidenceItem } from '../../../src/lib/publication/hosted/rules.ts';
import { missingOriginalAcknowledgement } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { BOUND, UNCITED_MISSING, freshOf, producerOf, runItems, type Item } from '../asset-policy/harness.ts';
import { CASE, CLIENT, RV, world } from '../signoff-root/harness.ts';
import { bothDiagnostics, disagreeingMeta, pocDatasets } from './poc.ts';

// U10 fix round 1 (review probe 3). ADR-0014 (Proposed): a META that disagrees clears when the derived disagreements are acknowledged with a
// reason and each has a matching validator diagnostic acknowledged. One exact acknowledgement must cover both, and nothing else.
const REASON = 'Legacy META disagrees; verified records are authoritative.';
const group = (fingerprints: string[], code = META_DISAGREEMENT_CODE, reason = REASON): AcknowledgementGroup => ({ code, reason, fingerprints });
const held = { code: 'required-section', detail: ['meta:disagrees'] };

async function metaWorld(o: { diagnostics?: string[]; withAsset?: boolean } = {}) {
  const diagnostics = o.diagnostics ?? bothDiagnostics();
  const meta = metaSectionV2(pocDatasets({ meta: disagreeingMeta }), { binding: BOUND, warningFingerprints: bothDiagnostics(), diagnostics: bothDiagnostics().length });
  expect(meta.state).toBe('disagrees');
  const items: Item[] = [...(o.withAsset === false ? runItems([]) : runItems([UNCITED_MISSING])).filter((i) => i.key !== 'section/meta'), ...metaEvidenceItems(meta),
    ...diagnostics.map((f) => ({ key: `warning/${f}`, observation: { kind: 'warning', fingerprint: f } }))].sort((a, b) => (a.key < b.key ? -1 : 1));
  const w = await world({ spec: { previews: 0, warnings: 0 }, baseline: 0, producer: producerOf(items) });
  const rows = (await w.reader.page({ clientId: CLIENT, caseId: CASE, candidateId: w.binding.candidateId, generation: w.binding.generation, root: w.root, after: null, kind: 'warning', limit: 100 }))!;
  const checked: CheckedEvidenceItem[] = rows.map((row) => checkEvidenceItem(row, { clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: BOUND.manifestSha256 })!);
  const derived = metaDisagreementsOf(checked), fresh = new Set(freshOf(w));
  const missing = checked.flatMap((i) => (i.missing ? [{ ...i.missing, fingerprint: (i.observation as { fingerprint: string }).fingerprint }] : []));
  return { w, derived, fresh, assetGroup: missingOriginalAcknowledgement(missing, fresh, 'Missing original acknowledged.'), s: await w.current() };
}

describe('one exact acknowledgement covers the derived disagreements and their validator warnings', () => {
  it('clears the pure rule whether the validator warnings are named in the META group, in another group, or not at all', async () => {
    const { s, derived, assetGroup } = await metaWorld();
    const d = derived.map((x) => x.fingerprint);
    expect(signoffBlockerV2(s, { disagreements: derived, acknowledgements: [assetGroup, group(d)] })).toBeNull();
    expect(signoffBlockerV2(s, { disagreements: derived, acknowledgements: [assetGroup, group([...d, ...bothDiagnostics()])] })).toBeNull();
    expect(signoffBlockerV2(s, { disagreements: derived, acknowledgements: [assetGroup, group(d), group(bothDiagnostics(), META_DISAGREEMENT_CODE, 'The e-mail and text counts.')] })).toBeNull();
    expect(signoffBlockerV2(s, { disagreements: derived, acknowledgements: [assetGroup, group(d), group(bothDiagnostics(), 'DS_OTHER')] })).toBeNull();
  });

  it('still holds for anything else: a missing derived fingerprint, an unrelated one, a repeat, a missing reason, another code', async () => {
    const { s, derived } = await metaWorld();
    const d = derived.map((x) => x.fingerprint), other = 'c'.repeat(32);
    const blocker = (...groups: AcknowledgementGroup[]) => signoffBlockerV2(s, { disagreements: derived, acknowledgements: groups });
    expect(blocker(group([d[0]!, ...bothDiagnostics()]))).toEqual(held);
    expect(blocker(group([...d, other]))).toEqual(held);
    expect(blocker(group([...d, ...bothDiagnostics(), bothDiagnostics()[0]!]))).toEqual(held);
    expect(blocker(group(d), group([d[0]!], META_DISAGREEMENT_CODE, 'Again.'))).toEqual(held);
    expect(blocker(group([...d, ...bothDiagnostics()], META_DISAGREEMENT_CODE, ' '))).toEqual(held);
    expect(blocker(group([...d, ...bothDiagnostics()], 'DS_OTHER'))).toEqual(held);
    expect(blocker()).toEqual(held);
  });

  it('signs through the real controller with one group, with split groups, and publishes', async () => {
    for (const split of [false, true]) {
      const { w, derived, assetGroup } = await metaWorld();
      const d = derived.map((x) => x.fingerprint);
      const acks = split ? [assetGroup, group(d), group(bothDiagnostics(), META_DISAGREEMENT_CODE, 'The matching validator warnings.')] : [assetGroup, group([...d, ...bothDiagnostics()])];
      const signed = await w.signOff({ acknowledgements: acks });
      expect(signed, `split=${split}`).toMatchObject({ status: 201, body: { state: 'signed-off' } });
      expect((await w.publish(signed.body.signoffId as string)).status).toBe(200);
    }
  });

  it('the controller still holds without the derived fingerprints, and refuses an unrelated one', async () => {
    const { w, derived, assetGroup } = await metaWorld();
    const d = derived.map((x) => x.fingerprint);
    expect(await w.signOff({ acknowledgements: [assetGroup, group(bothDiagnostics())] })).toMatchObject({ status: 422, body: { code: 'required-section', detail: ['meta:disagrees'] } });
    expect(await w.signOff({ acknowledgements: [assetGroup, group([...d, 'c'.repeat(32), ...bothDiagnostics()])] })).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('refuses a run whose derived disagreement has no matching validator warning', async () => {
    const { w, derived, assetGroup } = await metaWorld({ diagnostics: [bothDiagnostics()[0]!] });
    const d = derived.map((x) => x.fingerprint);
    const signed = await w.signOff({ acknowledgements: [assetGroup, group([...d, bothDiagnostics()[0]!])] });
    expect(signed.status).toBe(503);
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('a recorded sign-off publishes only while its acknowledgement still stands: publish rechecks with the recorded groups', async () => {
    const { w, derived, assetGroup } = await metaWorld();
    const d = derived.map((x) => x.fingerprint);
    const signed = await w.signOff({ acknowledgements: [assetGroup, group([...d, ...bothDiagnostics()])] });
    expect(signed.status).toBe(201);
    const stored = w.db.rows<{ acknowledgements: string }>('SELECT acknowledgements FROM pub_signoff')[0]!;
    expect(JSON.parse(stored.acknowledgements).groups.some((g: { code: string }) => g.code === META_DISAGREEMENT_CODE)).toBe(true);
    // A sign-off edited behind the application's back (the update trigger removed, as U5's tests do) has its META group recoded as another section's (counts unchanged): publish must see the section is no longer acknowledged.
    w.db.exec('DROP TRIGGER pub_signoff_update');
    w.db.exec(`UPDATE pub_signoff SET acknowledgements = replace(acknowledgements, '"${META_DISAGREEMENT_CODE}"', '"DS_OTHER"')`);
    const refused = await w.publish(signed.body.signoffId as string);
    expect(refused).toMatchObject({ status: 409, body: { code: 'signoff-stale', reason: 'candidate-blocked' } });
    expect(w.pointer()).toBeNull();
  });
});
