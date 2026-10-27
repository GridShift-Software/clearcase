// U14 (U5 follow-up L): v2 readiness reports a named sign-off as current only while it binds the run the snapshot names, its
// candidate, generation and root. A sign-off bound to another generation, another root or to no evidence at all is stale.
import { describe, expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import type { SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';
import { signoff } from '../../hosted-smoke/operator-workbench/fixtures.ts';
import { buildEvidence, fp, snapshotV2, worldV2 } from './harness.ts';

async function blockers(evidence: (s: { candidateId: string; generation: string; root: string }) => SignoffRecord['evidence']) {
  // Every warning is in the case's baseline, so nothing needs an acknowledgement and the counts match an empty acknowledgement list.
  const built = await buildEvidence({ previews: 3, warnings: 2 });
  const w = worldV2(built), snap = await snapshotV2(built);
  w.current = snap;
  const bound = { candidateId: snap.link.candidate.candidateId, generation: snap.evidence.generation, root: snap.evidence.root };
  const { evidence: _none, ...base } = signoff();
  const so: SignoffRecord = { ...base, warningFingerprints: [fp(0), fp(1)], acknowledgements: [], ...(evidence(bound) ? { evidence: evidence(bound) } : {}) };
  const ports = { ...w.ports, ledger: { ...w.ports.ledger!, signoff: async () => structuredClone(so) } };
  const response = await createPublicationReadiness(ports).read(w.request({ signoffId: so.signoffId }));
  expect(response.status).toBe(200);
  const body = await response.json() as { blocker: unknown; signoff: { blockers: string[] } };
  expect(body.blocker).toBeNull();
  return body.signoff.blockers;
}

describe('v2 readiness compares the sign-off evidence root with the snapshot root', () => {
  it('a sign-off bound to exactly this run is current', async () => {
    expect(await blockers((b) => b)).toEqual([]);
  });
  it('a sign-off bound to another root is stale', async () => {
    expect(await blockers((b) => ({ ...b, root: 'f'.repeat(64) }))).toEqual(['signoff-stale']);
  });
  it('a sign-off bound to another generation of the same candidate is stale, even with the same root', async () => {
    expect(await blockers((b) => ({ ...b, generation: '2' }))).toEqual(['signoff-stale']);
  });
  it('a sign-off bound to another candidate is stale', async () => {
    expect(await blockers((b) => ({ ...b, candidateId: 'another-candidate' }))).toEqual(['signoff-stale']);
  });
  it('a sign-off with no evidence binding is stale for a v2 candidate', async () => {
    expect(await blockers(() => undefined)).toEqual(['signoff-stale']);
  });
});
