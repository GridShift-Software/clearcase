// Unit contract regressions only: the real controller/ledger, synthetic SQLite and injected pointer/authority doubles.
import { expect, it } from 'vitest';
import { createNativePublication } from '../../../src/lib/publication/hosted/controller.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import type { NativePublicationPorts } from '../../../src/lib/publication/hosted/ports.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { CASE_A, CLIENT, MemoryAudit, MemoryCandidates, MemoryPublisher, PREPARER, RV_NEW, RV_OLD, SqliteD1, identity, snapshot } from './doubles.ts';

function world() {
  const db = new SqliteD1(), ledger = d1PublicationLedger(db), audit = new MemoryAudit(), candidates = new MemoryCandidates(), publisher = new MemoryPublisher();
  candidates.put(snapshot());
  let granted = true;
  const session = { revoked: false };
  const ports: NativePublicationPorts = { clientId: CLIENT, ledger, audit, candidates, publisher, now: () => new Date('2026-10-25T07:00:00.000Z'),
    authorize: async () => { if (!granted) throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } };
  const controller = createNativePublication(ports);
  function request(route: string, body: unknown, newSession = false) {
    const url = new URL(`https://client-a.clearcase.test/operator/publication/case-a/${route}`), who = identity(session);
    if (newSession && who.kind === 'verified') who.sessionId = id('session', 'sess-new-session');
    return { url, request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), params: { caseId: 'case-a' }, identity: who };
  }
  async function signOff() {
    const s = snapshot();
    const { candidateId: _candidateId, ...claimed } = {
      candidateId: s.link.candidate.candidateId, linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
      resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
      diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
    };
    const body = { operationId: 'signoff-boundary-00001', candidateId: 'cand-0001', identity: claimed, selfApproval: false, acknowledgements: [{ fingerprint: 'f'.repeat(32), reason: 'Reviewed synthetic warning' }] };
    const response = await controller.signOff(request('signoffs', body));
    expect(response.status).toBe(201);
    return { signoffId: (await response.json()).signoffId as string, body };
  }
  return { db, ledger, audit, candidates, publisher, ports, controller, request, signOff, session, revoke: () => { granted = false; } };
}
const publishBody = (signoffId: string, operationId = 'publish-boundary-00001') => ({ operationId, signoffId, expected: { kind: 'none' } });
const withdrawBody = () => ({ operationId: 'withdraw-boundary-0001', resultsVersion: RV_OLD, expected: { kind: 'published', resultsVersion: RV_OLD } });

it('an invalidated sign-off cannot publish even when the candidate bytes/revision are unchanged', async () => {
  const w = world(), { signoffId } = await w.signOff();
  w.publisher.beforeRecheck = async () => {
    await w.ledger.invalidateSignoff({ clientId: CLIENT, caseId: CASE_A, signoffId, at: '2026-10-25T07:01:00.000Z', reason: 'review-withdrawn' });
  };
  expect((await w.controller.publish(w.request('publish', publishBody(signoffId)))).status).toBe(409);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'none' });
  expect(w.publisher.receipts.size).toBe(0);
});

it('a candidate-only change at the adapter boundary is re-read, invalidates sign-off, and cannot be reverted into approval', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.publisher.beforeRecheck = async () => { w.candidates.put(snapshot({ snapshotRevision: 'snap-2' })); };
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(409);
  w.publisher.beforeRecheck = null;
  w.candidates.put(snapshot());
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(409);
  expect(w.publisher.calls).toHaveLength(0);
  expect(w.publisher.receipts.size).toBe(0);
});

for (const route of ['publish', 'withdraw'] as const) {
  it(`${route} checks a revoked explicit grant at the adapter boundary, not just at admission`, async () => {
    const w = world(), { signoffId } = await w.signOff();
    if (route === 'withdraw') w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_OLD });
    const before = w.publisher.current(CASE_A);
    w.publisher.beforeRecheck = async () => { w.revoke(); };
    const body = route === 'publish' ? publishBody(signoffId) : withdrawBody();
    expect((await w.controller[route](w.request(route, body))).status).toBe(403);
    expect(w.publisher.current(CASE_A)).toEqual(before);
    expect(w.publisher.receipts.size).toBe(0);
    expect(w.audit.events.map(e => e.action)).toEqual(['publication.signoff']);
  });

  it(`${route} checks session revocation at the adapter boundary`, async () => {
    const w = world(), { signoffId } = await w.signOff();
    if (route === 'withdraw') w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_OLD });
    const before = w.publisher.current(CASE_A);
    w.publisher.beforeRecheck = async () => { w.session.revoked = true; };
    const body = route === 'publish' ? publishBody(signoffId) : withdrawBody();
    expect((await w.controller[route](w.request(route, body))).status).toBe(401);
    expect(w.publisher.current(CASE_A)).toEqual(before);
    expect(w.publisher.receipts.size).toBe(0);
  });
}

it('current pointer equality without this operation receipt does not bypass expected-state CAS', async () => {
  const w = world(), { signoffId } = await w.signOff();
  w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_NEW });
  expect((await w.controller.publish(w.request('publish', publishBody(signoffId)))).status).toBe(409);
  expect(w.publisher.receipts.size).toBe(0);
  expect(w.audit.events.map(e => e.action)).toEqual(['publication.signoff']);
});

it('a lost commit acknowledgement recovers by operation receipt after restart, invalidation and a newer publication', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.publisher.loseNextAcknowledgement = true;
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  expect((await w.ledger.operation({ clientId: CLIENT, caseId: CASE_A, operationId: body.operationId }))?.state).toBe('failed');
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'published', resultsVersion: RV_NEW });
  w.candidates.put(snapshot({ snapshotRevision: 'snap-2' }));
  await w.ledger.invalidateSignoff({ clientId: CLIENT, caseId: CASE_A, signoffId, at: '2026-10-25T07:01:00.000Z', reason: 'edited' });
  w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_OLD });
  const restarted = createNativePublication({ ...w.ports, ledger: d1PublicationLedger(w.db) });
  expect((await restarted.publish(w.request('publish', body, true))).status).toBe(200);
  expect(w.publisher.calls).toEqual([`publish:case-a:${RV_NEW}`]);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'published', resultsVersion: RV_OLD });
  expect(w.audit.events.find(e => e.action === 'publication.publish')?.version).toBe(RV_NEW);
});

it('withdrawal with a failed ledger outcome recovers before reapplying against a later pointer', async () => {
  const w = world(), body = withdrawBody();
  w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_OLD });
  w.db.failNext = /UPDATE pub_operation SET state =/;
  expect((await w.controller.withdraw(w.request('withdraw', body))).status).toBe(503);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'withdrawn', resultsVersion: RV_OLD });
  w.publisher.pointer.set(CASE_A, { kind: 'published', resultsVersion: RV_NEW });
  expect((await w.controller.withdraw(w.request('withdraw', body))).status).toBe(200);
  expect(w.publisher.calls).toEqual([`withdraw:case-a:${RV_OLD}`]);
  expect(w.publisher.current(CASE_A)).toEqual({ kind: 'published', resultsVersion: RV_NEW });
  expect(w.audit.events.map(e => e.action)).toEqual(['publication.withdraw']);
});

it('a cross-session audit retry uses the original persisted event envelope and event id', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.db.failNext = /UPDATE pub_operation SET state = 'audited'/;
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  const original = structuredClone(w.audit.events.find(e => e.action === 'publication.publish'));
  w.candidates.put(snapshot({ snapshotRevision: 'snap-2' }));
  expect((await w.controller.publish(w.request('publish', body, true))).status).toBe(200);
  const attempts = w.audit.events.filter(e => e.action === 'publication.publish');
  expect(attempts).toEqual([original, original]); // the real audit sink deduplicates eventId, not retry sessions
});

it('sign-off audit retries also keep their original envelope across sessions', async () => {
  const w = world();
  w.db.failNext = /UPDATE pub_signoff SET state = 'audited'/;
  const s = snapshot(), claimed = { linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
    resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
    diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision };
  const body = { operationId: 'signoff-boundary-00001', candidateId: 'cand-0001', identity: claimed, selfApproval: false, acknowledgements: [{ fingerprint: 'f'.repeat(32), reason: 'Reviewed synthetic warning' }] };
  expect((await w.controller.signOff(w.request('signoffs', body))).status).toBe(503);
  const original = structuredClone(w.audit.events[0]);
  expect((await w.controller.signOff(w.request('signoffs', body, true))).status).toBe(201);
  expect(w.audit.events).toEqual([original, original]);
});

it('a receipt with different durable intent is refused, not treated as proof of application', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.db.failNext = /UPDATE pub_operation SET state =/;
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  const [key, receipt] = [...w.publisher.receipts][0];
  w.publisher.receipts.set(key, { intent: { ...receipt.intent, requestSha256: '0'.repeat(64) } });
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  expect(w.publisher.calls).toHaveLength(1);
  expect(w.audit.events.map(e => e.action)).toEqual(['publication.signoff']);
});

it('durable intent pins every signed field and the audit envelope and refuses rewrites', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(200);
  const rec = await w.ledger.operation({ clientId: CLIENT, caseId: CASE_A, operationId: body.operationId });
  expect(rec?.signedIdentity).toEqual({ candidateId: 'cand-0001', linkId: snapshot().link.linkId, submissionRevisionId: snapshot().link.submissionRevisionId,
    submissionManifestSha256: snapshot().link.submissionManifestSha256, resultsVersion: RV_NEW, manifestSha256: snapshot().link.candidate.manifestSha256,
    packageInputRevisionId: 'inrev-1', diagnosticsSha256: snapshot().validation.diagnosticsSha256, validatorVersion: 'validator-1', snapshotRevision: 'snap-1' });
  expect(rec?.auditEvent).toEqual(w.audit.events.find(e => e.action === 'publication.publish'));
  for (const column of ['signed_identity', 'audit_event']) expect(() => w.db.exec(`UPDATE pub_operation SET ${column} = '{}'`)).toThrow();
  expect(() => w.db.exec("UPDATE pub_signoff SET audit_event = '{}'" )).toThrow();
});

it('an old unguarded publisher cannot be composed as a working implementation', async () => {
  const w = world();
  Object.defineProperty(w.publisher, 'protocol', { value: undefined });
  expect((await w.controller.withdraw(w.request('withdraw', withdrawBody()))).status).toBe(503);
  expect(w.publisher.calls).toHaveLength(0);
});

it('two different actors racing the same expected pointer cannot both publish', async () => {
  const w = world(), { signoffId } = await w.signOff();
  const second = w.request('publish', publishBody(signoffId, 'publish-boundary-00002'));
  second.identity = identity({ principal: PREPARER });
  const out = await Promise.all([w.controller.publish(w.request('publish', publishBody(signoffId))), w.controller.publish(second)]);
  expect(out.map(r => r.status).sort()).toEqual([200, 409]);
  expect(w.publisher.receipts.size).toBe(1);
  expect(w.audit.events.filter(e => e.action === 'publication.publish')).toHaveLength(1);
});

it('concurrent retries of one operation apply once and settle monotonically', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  // Admit both as pending, then hold the second outcome write until its peer has settled its audit.
  let bothBegun!: () => void, beginning = 0;
  const pendingPeers = new Promise<void>(resolve => { bothBegun = resolve; });
  const begin = w.ledger.beginOperation.bind(w.ledger);
  w.ledger.beginOperation = async op => {
    const out = await begin(op);
    if (++beginning === 2) bothBegun();
    await pendingPeers;
    return out;
  };
  let release!: () => void, finishing = 0;
  const peerCompleted = new Promise<void>(resolve => { release = resolve; });
  const finish = w.ledger.finishOperation.bind(w.ledger);
  w.ledger.finishOperation = async a => {
    if (a.state === 'applied' && ++finishing === 2) await peerCompleted;
    return finish(a);
  };
  const run = async (newSession: boolean) => {
    const r = await w.controller.publish(w.request('publish', body, newSession));
    release();
    return r;
  };
  const out = await Promise.all([run(false), run(true)]);
  expect(finishing).toBe(2);
  expect(out.map(r => r.status)).toEqual([200, 200]);
  expect(w.publisher.calls).toHaveLength(1);
  expect(w.publisher.receipts.size).toBe(1);
  const events = w.audit.events.filter(e => e.action === 'publication.publish');
  expect(new Set(events.map(e => e.eventId)).size).toBe(1);
  expect(events.every(e => JSON.stringify(e) === JSON.stringify(events[0]))).toBe(true);
});

for (const [reason, status] of [['forbidden', 403], ['invalid-session', 401], ['signoff-stale', 409]] as const) {
  it(`preserves the adapter's typed atomic ${reason} predicate refusal`, async () => {
    const w = world(), { signoffId } = await w.signOff();
    w.publisher.publish = async () => ({ kind: 'guard-refused', reason });
    expect((await w.controller.publish(w.request('publish', publishBody(signoffId)))).status).toBe(status);
    expect(w.publisher.current(CASE_A)).toEqual({ kind: 'none' });
    expect(w.publisher.receipts.size).toBe(0);
    expect(w.audit.events.map(e => e.action)).toEqual(['publication.signoff']);
  });
}

it('an unapplied retry exposes current authority to the adapter while preserving the original audit session', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.publisher.failNext = 'publish';
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  const apply = w.publisher.publish.bind(w.publisher);
  let checked = false;
  w.publisher.publish = async a => {
    expect(a.authority).toMatchObject({ clientId: CLIENT, caseId: CASE_A, sessionId: 'sess-new-session', capability: 'publish' });
    expect(a.intent.auditEvent.actor).toMatchObject({ sessionId: 'sess-publisher-q' });
    checked = true;
    return apply(a);
  };
  expect((await w.controller.publish(w.request('publish', body, true))).status).toBe(200);
  expect(checked).toBe(true);
});

it('receipt-only recovery never reapplies after a grant is revoked following admission', async () => {
  const w = world(), { signoffId } = await w.signOff(), body = publishBody(signoffId);
  w.db.failNext = /UPDATE pub_operation SET state =/;
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(503);
  const begin = w.ledger.beginOperation.bind(w.ledger);
  w.ledger.beginOperation = async op => { w.revoke(); return begin(op); };
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(200);
  expect(w.publisher.calls).toEqual([`publish:case-a:${RV_NEW}`]);
  expect(w.audit.events.map(e => e.action)).toEqual(['publication.signoff', 'publication.publish']);
  // Once admission sees the revoked grant, even recovery is refused without another state read or mutation.
  expect((await w.controller.publish(w.request('publish', body))).status).toBe(403);
  expect(w.publisher.calls).toHaveLength(1);
});
