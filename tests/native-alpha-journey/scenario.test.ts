// Harness self-tests. Every world here is the in-process self-test world of world.ts: these tests prove the runner's
// judgements (it passes a faithful world and catches each seeded defect), not that the deployed system is correct.
import { describe, expect, it } from 'vitest';
import { runJourney } from './harness.ts';
import type { Defect } from './world.ts';

describe('the journey against a faithful self-test world (positive control only)', () => {
  it('reaches AWAITING-HUMAN-SIGNOFF, then publishes, and reads the same facts back after a restart', async () => {
    const j = await runJourney([], { foreign: true });
    expect(j.failed).toEqual([]);
    expect(j.p1.state?.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(j.p2?.readback?.publication.kind).toBe('published');
    expect(j.p3?.readback).not.toBeNull();
  });
  it('a separate reviewer session signs off without claiming self-approval', async () => {
    expect((await runJourney([], { reviewer: true })).failed).toEqual([]);
  });
});

// Each seeded defect is something the real system must never do. The expected id is the check that has to notice it.
const cases: [Defect, string, { foreign?: boolean }?][] = [
  ['leakWrongClientOriginal', 'p2.sweep.original.other-client'],
  ['previewPublic', 'p1.client-no-chronology'],
  ['crossOriginAccepted', 'p1.cross-origin'],
  ['refusalDeletesNotes', 'p2.preserved'],
  ['unknownDiffersFromForeign', 'p1.foreign-case', { foreign: true }],
  ['revokedAccepted', 'p1.declare-refused.revoked'],
  ['staleSignoffAccepted', 'p2.signoff-stale'],
  ['wrongSha', 'p1.health'],
  ['dirtyBuild', 'p1.health'],
  ['testIdentity', 'p1.health'],
  ['publishAnySignoff', 'p2.publish-unknown-signoff'],
  ['wrongOriginalBytes', 'p2.client-pdf-bytes'],
  ['noCitationLink', 'p2.client-citation-link'],
  ['operatorDownloadOpen', 'p1.download-refused.client-a'],
  ['extraUploadAccepted', 'p1.no-extra-upload'],
  ['uploadMutatesOnRefusal', 'p1.no-extra-upload'],
];
describe('each seeded defect is caught by the check that owns it', () => {
  for (const [defect, id, opts] of cases) {
    it(`${defect} fails ${id}`, async () => {
      const j = await runJourney([defect], opts ?? {});
      expect(j.failed).toContain(id);
    });
  }
  it('notes lost across a restart fail the readback comparison', async () => {
    const j = await runJourney(['notesLostOnRestart']);
    expect(j.failed).toContain('p3.readback-equal');
  });
});
