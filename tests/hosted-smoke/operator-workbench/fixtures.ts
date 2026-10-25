// Synthetic unit ports only; not native runtime evidence.
import type { AuditEvent, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { id, resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';
import type { CandidateSnapshot, SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';
import type { LinkedCandidate } from '../../../src/lib/results-review/native/ports.ts';
import type { OperatorSubmissionView } from '../../../src/lib/submissions/download/controller.ts';

import type { PublicationReadinessPorts } from '../../../src/lib/publication/hosted/readiness.ts';
import type { ReadinessFence } from '../../../src/lib/publication/hosted/readiness-fence.ts';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';

// One synchronous in-memory observation, only for unit ports. SQL regressions use d1ReadinessFence instead.
export function syntheticFence(snapshot: () => CandidateSnapshot, signoff: () => SignoffRecord | null = () => null): ReadinessFence {
  return { protocol: 'coherent-readiness/1', async check(o) {
    return canonicalJson(snapshot()) === canonicalJson(o.snapshot)
      && (o.signoff === null || canonicalJson(signoff()) === canonicalJson(o.signoff)) ? 'current' : 'stale';
  } };
}

export const CLIENT = id('client', 'synthetic-client');
export const CASE = id('case', 'synthetic-case');
export const RV = resultsVersion(`sha256:${'a'.repeat(64)}`);
export const FP = 'b'.repeat(32);
export const SHA = 'c'.repeat(64);
export const principal = { issuer: 'https://synthetic.invalid', subject: 'synthetic-operator', kind: 'staff' as const };
export function snapshot(): CandidateSnapshot {
  return {
    link: { linkId: 'link-synthetic', clientId: CLIENT, caseId: CASE, submissionRevisionId: 'subrev-synthetic', submissionManifestSha256: sha256(SHA),
      candidate: { clientId: CLIENT, caseId: CASE, candidateId: 'cand-synthetic', resultsVersion: RV, manifestSha256: sha256(SHA), packageInputRevisionId: id('input-revision', 'sha256:synthetic-input') } },
    preparedBy: { issuer: principal.issuer, subject: principal.subject }, snapshotRevision: 'd1:1',
    validation: { verdict: 'report', validatorVersion: 'synthetic-validator/1', diagnosticsSha256: SHA, errorFingerprints: [], warningFingerprints: [FP] },
    trustedBaseline: [], requiredSections: [{ key: 'matter', state: 'valid' }], requiredPreviews: [{ assetId: 'synthetic-pdf', state: 'rendered' }],
  };
}
export function world() {
  let current = snapshot();
  const events: AuditEvent[] = [];
  let reads = 0, grants = 0, previews = 0;
  const identity: Identity = { kind: 'verified', principal, sessionId: id('session', 'synthetic-session'), clientId: CLIENT,
    async checkRevocation() {}, async authorize(a) { if (a.operation !== 'read-preview') throw new Error('wrong operation'); previews++; } };
  const noMutation = async (): Promise<never> => { throw new Error('Readiness must never mutate publication or sign-off'); };
  const ports: PublicationReadinessPorts = {
    readinessFence: syntheticFence(() => current),
    clientId: CLIENT, authorize: async (a) => { if (a.capability !== 'publish') throw new Error('wrong grant'); grants++; },
    candidates: { read: async () => { reads++; return structuredClone(current); } },
    publisher: { protocol: 'atomic-publication/1', receipt: noMutation, publish: noMutation, withdraw: noMutation },
    ledger: { recordSignoff: noMutation, signoff: async () => null, settleSignoff: noMutation, invalidateSignoff: noMutation,
      operation: noMutation, beginOperation: noMutation, finishOperation: noMutation, settleOperation: noMutation },
    audit: { async append(e) { events.push(e); return { eventId: e.eventId }; } }, now: () => new Date('2026-10-25T10:00:00.000Z'),
  };
  const request = () => {
    const url = new URL(`https://synthetic.invalid/operator/publication/${CASE}/readiness?candidateId=cand-synthetic`);
    return { request: new Request(url), url, params: { caseId: CASE }, identity };
  };
  return { ports, identity, request, events, get current() { return current; }, set current(s: CandidateSnapshot) { current = s; }, get reads() { return reads; }, get grants() { return grants; }, get previews() { return previews; } };
}
export function candidate(): LinkedCandidate {
  const s = snapshot();
  return { candidateId: s.link.candidate.candidateId, origin: 'import', parentCandidateId: null, current: true, supersededBy: null,
    link: { ...s.link, candidate: { ...s.link.candidate, manifestSha256: sha256(SHA), packageInputRevisionId: id('input-revision', s.link.candidate.packageInputRevisionId) },
      submissionManifestSha256: sha256(SHA), format: 'clearcase.candidate-import-link/1', coverage: { policy: 'exact-required-file-set/1', mappedOriginals: [], unavailableOriginals: [] }, operator: principal,
      linkedAt: '2026-10-25T10:00:00.000Z', attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' }, correction: null };
}
export function submission(): OperatorSubmissionView {
  return { operationId: 'op-synthetic00000000', revisionId: 'subrev-synthetic', sequence: 1, clientId: CLIENT, caseId: CASE,
    manifest: { format: 'clearcase.submission-manifest/1', clientId: CLIENT, caseId: CASE, operationId: 'op-synthetic00000000', revisionId: 'subrev-synthetic', sequence: 1, finalizedAt: '2026-10-25T10:00:00.000Z', files: [] },
    manifestSha256: SHA, manifestHref: '/synthetic-manifest', downloadHref: '/synthetic-download', files: [] };
}
export function signoff(): SignoffRecord {
  const s = snapshot();
  return { candidateId: s.link.candidate.candidateId, linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: SHA,
    resultsVersion: RV, manifestSha256: SHA, packageInputRevisionId: s.link.candidate.packageInputRevisionId, diagnosticsSha256: SHA, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
    signoffId: 'so-synthetic000000000', operationId: 'synthetic000000000', requestSha256: SHA, clientId: CLIENT, caseId: CASE, warningFingerprints: [FP], acknowledgements: [{ fingerprint: FP, reason: 'Synthetic reviewed warning' }],
    signer: principal, preparedBy: s.preparedBy, selfApproval: true, signedAt: '2026-10-25T10:00:00.000Z',
    auditEvent: { eventId: 'synthetic', actor: { kind: 'anonymous', principal: null, sessionId: null }, action: 'synthetic', object: { kind: 'synthetic', id: 'synthetic', caseId: CASE }, version: RV, outcome: 'succeeded', at: '2026-10-25T10:00:00.000Z' },
    state: 'audited', invalidatedAt: null, invalidatedReason: null };
}
