// Real immutable sign-off ledger fixture. No controller acceptance is claimed: the base's digest guard is separately owned.
import { expect } from 'vitest';
import { world, NOW } from './fixture.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import type { SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';

export type World = Awaited<ReturnType<typeof world>>;
export async function approve(w: World) {
  const s = await w.read();
  if (!s || w.options.identity.kind !== 'verified') throw new Error('fixture snapshot/identity');
  const who = w.options.identity;
  const signed: SignoffRecord = {
    signoffId: 'so-provenance-regression', operationId: 'provenance-signoff', requestSha256: 'a'.repeat(64),
    ...w.scope, linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId,
    submissionManifestSha256: s.link.submissionManifestSha256, resultsVersion: w.rv,
    manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
    diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
    warningFingerprints: s.validation.warningFingerprints,
    acknowledgements: s.validation.warningFingerprints.map((fingerprint) => ({ fingerprint, reason: 'Reviewed synthetic fixture' })),
    signer: who.principal, preparedBy: s.preparedBy, selfApproval: false, signedAt: NOW,
    state: 'recorded', invalidatedAt: null, invalidatedReason: null,
    auditEvent: { eventId: 'provenance-signoff-audit', actor: { kind: 'verified', principal: who.principal, sessionId: who.sessionId },
      action: 'publication.signoff', object: { kind: 'publication', id: 'so-provenance-regression', caseId: w.scope.caseId },
      version: w.rv, outcome: 'succeeded', at: NOW },
  };
  const ledger = d1PublicationLedger(w.db);
  expect((await ledger.recordSignoff(signed)).kind).toBe('recorded');
  await w.options.audit.append(signed.auditEvent);
  await ledger.settleSignoff({ ...w.scope, signoffId: signed.signoffId });
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).toBeNull();
  return { ledger, signed, snapshot: s };
}
