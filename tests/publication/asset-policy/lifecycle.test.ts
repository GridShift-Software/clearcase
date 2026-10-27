import { describe, expect, it } from 'vitest';
import { ASSET_ACK_CODE, missingAssetDiagnostic, missingOriginalAcknowledgement, missingOriginalFingerprint } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { snapshotV2, worldV2 } from '../readiness-v2/harness.ts';
import type { CandidateSnapshotV2 } from '../../../src/lib/publication/hosted/ports.ts';
import { RV } from '../signoff-root/harness.ts';
import { BOUND, FIXTURE_BOUND, UNCITED_MISSING, assetWorld, buildAssetEvidence, freshOf } from './harness.ts';

// U10 fix round 2 (re-check M1 and M2, and the consumer sweep). Every consumer of a missing-original exception asks for the same evidence, and
// sign-off and publish decide the acknowledgements by the same rule: a fresh warning is acknowledged once, under its own code, and a warning the
// case's baseline already holds is never acknowledged again.
const diagnostic = missingAssetDiagnostic(UNCITED_MISSING.assetId);
const REASON = 'Reviewed the missing original.';

describe('M1: readiness serves a missing original only with the validator warning it stands on', () => {
  const unwarned = () => buildAssetEvidence([UNCITED_MISSING], FIXTURE_BOUND, (items) => items.filter((i) => i.key !== `warning/${diagnostic}`));

  it('a canonical, currently bound exception without its ASSET_MISSING_AT_BUILD warning is unavailable, on any page', async () => {
    for (const params of [{}, { kind: 'warning' }] as Record<string, string>[]) {
      const w = worldV2(await unwarned());
      const response = await createPublicationReadiness(w.ports).read(w.request(params));
      const body = await response.json() as Record<string, unknown>;
      expect(response.status, JSON.stringify(body)).toBe(503);
      expect(JSON.stringify(body)).not.toContain('acknowledgement');
    }
  });

  it('the run summary does not count it as a missing original', async () => {
    const built = await unwarned();
    const { clientId, caseId, candidateId, generation } = built.binding;
    const summary = await built.reader.summary({ clientId: clientId as never, caseId: caseId as never, candidateId, generation });
    expect(summary).not.toBeNull();
    expect(summary!.groups.filter((g) => g.kind === 'warning').map((g) => g.state)).not.toContain('original-not-supplied');
  });

  it('the same run with the warning reads as before', async () => {
    const w = worldV2(await buildAssetEvidence([UNCITED_MISSING]));
    const response = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }));
    expect(response.status).toBe(200);
  });
});

describe('M2: a missing original the baseline already holds is not acknowledged again', () => {
  it('acknowledge and publish, sign again with nothing new, publish again', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const fingerprint = missingOriginalFingerprint(BOUND, UNCITED_MISSING.assetId, diagnostic);
    const first = await w.signOff({ acknowledgements: [missingOriginalAcknowledgement([{ diagnostic, fingerprint }], new Set(freshOf(w)), REASON)] });
    expect(first.status).toBe(201);
    expect((await w.publish(first.body.signoffId as string)).status).toBe(200);
    expect(freshOf(w)).toEqual([]);
    // Sign-off refuses to acknowledge a trusted fingerprint, so a sign-off with no acknowledgement is the only one there is.
    expect(await w.signOff({ acknowledgements: [{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: [fingerprint] }] })).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    const again = await w.signOff({ acknowledgements: [] });
    expect(again.status).toBe(201);
    const published = await w.publish(again.body.signoffId as string, { expected: { kind: 'published', resultsVersion: RV } });
    expect(published, JSON.stringify(published)).toMatchObject({ status: 200 });
  });
});

describe('the validator warning of a missing original is acknowledged under its own code too', () => {
  const groups = (diagnosticCode: string) => {
    const fingerprint = missingOriginalFingerprint(BOUND, UNCITED_MISSING.assetId, diagnostic);
    return [{ code: ASSET_ACK_CODE, reason: REASON, fingerprints: [fingerprint] }, { code: diagnosticCode, reason: 'The validator warning.', fingerprints: [diagnostic] }];
  };

  it('sign-off refuses it under another code, and accepts it under ASSET_MISSING_AT_BUILD', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    expect(await w.signOff({ acknowledgements: groups('DS_OTHER') })).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
    expect((await w.signOff({ acknowledgements: groups(ASSET_ACK_CODE) })).status).toBe(201);
  });

  it('publish refuses a recorded sign-off whose validator warning was recoded behind the application', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    const signed = await w.signOff({ acknowledgements: groups(ASSET_ACK_CODE) });
    expect(signed.status).toBe(201);
    w.db.exec('DROP TRIGGER pub_signoff_update');
    w.db.exec(`UPDATE pub_signoff SET acknowledgements = replace(acknowledgements, '"code":"${ASSET_ACK_CODE}","reason":"The validator warning."', '"code":"DS_OTHER","reason":"The validator warning."')`);
    expect(w.db.rows<{ a: string }>('SELECT acknowledgements AS a FROM pub_signoff')[0]!.a).toContain('DS_OTHER');
    expect(await w.publish(signed.body.signoffId as string)).toMatchObject({ status: 409, body: { code: 'signoff-stale', reason: 'warnings-changed' } });
    expect(w.pointer()).toBeNull();
  });
});

describe('fix round 3: a summary computed before the warning check is not evidence of one', () => {
  // What the summary query wrote before fix round 2, for the same immutable rows: every missing original's warning as `original-not-supplied`.
  const older = (s: CandidateSnapshotV2): CandidateSnapshotV2 => ({ ...s, evidence: { ...s.evidence,
    groups: s.evidence.groups.map((g) => (g.kind === 'warning' && g.state !== null ? { ...g, state: 'original-not-supplied' } : g)) } });

  it('readiness refuses an older cached summary of an unwarned exception', async () => {
    const built = await buildAssetEvidence([UNCITED_MISSING], FIXTURE_BOUND, (items) => items.filter((i) => i.key !== `warning/${diagnostic}`));
    const w = worldV2(built, { snapshot: older(await snapshotV2(built)) });
    const response = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(503);
  });

  it('readiness refuses an older cached summary of a warned exception too, until the summary is computed again', async () => {
    const built = await buildAssetEvidence([UNCITED_MISSING]);
    const stale = worldV2(built, { snapshot: older(await snapshotV2(built)) });
    expect((await createPublicationReadiness(stale.ports).read(stale.request())).status).toBe(503);
    const fresh = worldV2(built);
    expect((await createPublicationReadiness(fresh.ports).read(fresh.request())).status).toBe(200);
  });

  it('sign-off refuses an older cached summary, and records nothing', async () => {
    const w = await assetWorld([UNCITED_MISSING]);
    await w.freezeSnapshot(older);
    const fingerprint = missingOriginalFingerprint(BOUND, UNCITED_MISSING.assetId, diagnostic);
    const signed = await w.signOff({ acknowledgements: [missingOriginalAcknowledgement([{ diagnostic, fingerprint }], new Set(freshOf(w)), REASON)] });
    expect(signed.status).toBe(503);
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
    expect(w.pointer()).toBeNull();
  });
});
