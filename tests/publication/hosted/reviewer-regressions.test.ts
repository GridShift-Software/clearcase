// Protected reviewer regressions P1/P2/P3; original assertions preserved. Unit doubles only.
import { expect, it } from 'vitest';
import { createNativePublication } from '../../../src/lib/publication/hosted/controller.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import type { CandidateSnapshot, NativePublicationPorts } from '../../../src/lib/publication/hosted/ports.ts';
import { CLIENT, CASE_A, MemoryAudit, MemoryCandidates, MemoryPublisher, PUBLISHER, RV_NEW, SqliteD1, identity, snapshot } from './doubles.ts';

function world() {
  const db = new SqliteD1(), ledger = d1PublicationLedger(db), audit = new MemoryAudit(), candidates = new MemoryCandidates(), publisher = new MemoryPublisher();
  candidates.put(snapshot());
  let granted = true;
  const ports: NativePublicationPorts = { clientId: CLIENT, ledger, audit, candidates, publisher, now: () => new Date('2026-10-25T06:00:00.000Z'), authorize: async () => { if (!granted) throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } };
  const controller = createNativePublication(ports);
  const request = (route: string, body: unknown) => { const url = new URL(`https://client-a.clearcase.test/operator/publication/case-a/${route}`); return { url, request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), params: { caseId: 'case-a' }, identity: identity() }; };
  async function signOff() {
    const s = snapshot();
    const claimed = { linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256, resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId, diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision };
    const r = await controller.signOff(request('signoffs', { operationId: 'signoff-0000000001', candidateId: 'cand-0001', identity: claimed, selfApproval: false, acknowledgements: [{ fingerprint: 'f'.repeat(32), reason: 'Reviewed synthetic warning' }] }));
    expect(r.status).toBe(201);
    return (await r.json()).signoffId as string;
  }
  return { db, ledger, audit, candidates, publisher, ports, controller, request, signOff, revoke: () => { granted = false; } };
}

it('review P1: an edit and explicit signoff invalidation before pointer commit must block publication', async () => {
  const w = world(), signoffId = await w.signOff();
  const begin = w.ledger.beginOperation.bind(w.ledger);
  w.ledger.beginOperation = async (op) => {
    w.candidates.put(snapshot({ snapshotRevision: 'snap-2' }));
    await w.ledger.invalidateSignoff({ clientId: CLIENT, caseId: CASE_A, signoffId, at: '2026-10-25T06:01:00.000Z', reason: 'reviewer-edit' });
    return begin(op);
  };
  const r = await w.controller.publish(w.request('publish', { operationId: 'publish-0000000001', signoffId, expected: { kind: 'none' } }));
  console.log('P1 actual', r.status, await r.clone().json(), 'pointer', w.publisher.current(CASE_A), 'signoff', await w.ledger.signoff({ clientId: CLIENT, caseId: CASE_A, signoffId }));
  expect(r.status).toBe(409);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'none' });
});

it('review P2: revoking the explicit publish grant before pointer commit must block publication', async () => {
  const w = world(), signoffId = await w.signOff();
  const begin = w.ledger.beginOperation.bind(w.ledger);
  w.ledger.beginOperation = async (op) => { w.revoke(); return begin(op); };
  const r = await w.controller.publish(w.request('publish', { operationId: 'publish-0000000002', signoffId, expected: { kind: 'none' } }));
  console.log('P2 actual', r.status, await r.clone().json(), 'pointer', w.publisher.current(CASE_A));
  expect(r.status).toBe(403);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'none' });
});

it('review P3: a successful CAS with a failed ledger outcome write must remain auditable after a candidate edit', async () => {
  const w = world(), signoffId = await w.signOff();
  const body = { operationId: 'publish-0000000003', signoffId, expected: { kind: 'none' } };
  w.db.failNext = /UPDATE pub_operation SET state =/;
  const first = await w.controller.publish(w.request('publish', body));
  expect(first.status).toBe(503);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'published', resultsVersion: RV_NEW });
  w.candidates.put(snapshot({ snapshotRevision: 'snap-2' }));
  const retry = await w.controller.publish(w.request('publish', body));
  console.log('P3 actual', first.status, retry.status, await retry.clone().json(), 'operation', await w.ledger.operation({ clientId: CLIENT, caseId: CASE_A, operationId: body.operationId }), 'audit actions', w.audit.events.map(e => e.action));
  expect(retry.status).toBe(200);
  expect(w.audit.events.map(e => e.action)).toContain('publication.publish');
});
