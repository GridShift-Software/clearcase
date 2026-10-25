// Native exact-version sign-off and publication (ADR-0010): the adverse HTTP contract of the operator publication routes
// and the D1 ledger. Synthetic data; identity, grants, candidate reader, pointer and audit are unit doubles (doubles.ts),
// so a pass here is component evidence only, never a hosted or native PASS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { CandidateSnapshot, NativePublicationPorts } from '../../../src/lib/publication/hosted/ports.ts';
import { CASE_A, CASE_B, CLIENT, MemoryAudit, MemoryCandidates, MemoryPublisher, PREPARER, PUBLISHER, RV_NEW, RV_OLD, STRANGER, SqliteD1, grants, identity, snapshot, trackedBody } from './doubles.ts';
import { ROUTES, compose, dispatch, ledgerFor, type Route } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const F_NEW = 'f'.repeat(32), F_BASE = 'e'.repeat(32);

function world(o: { grants?: string[]; ports?: Partial<NativePublicationPorts>; configured?: boolean; snap?: CandidateSnapshot } = {}) {
  const db = new SqliteD1(), audit = new MemoryAudit(), publisher = new MemoryPublisher(), candidates = new MemoryCandidates(), calls: string[] = [];
  candidates.put(o.snap ?? snapshot());
  const ports: NativePublicationPorts = {
    clientId: CLIENT, authorize: grants(o.grants ?? [`${PUBLISHER.subject}:${CASE_A}`, `${PREPARER.subject}:${CASE_A}`], calls),
    candidates, publisher, ledger: ledgerFor(db), audit, now: () => new Date('2026-10-25T06:00:00.000Z'), ...o.ports,
  };
  compose(o.configured === false ? null : ports);
  return { db, audit, publisher, candidates, calls, ports };
}

let seq = 0;
const op = () => `op-${String(++seq).padStart(4, '0')}-5b2c7d1e`;
type Init = { origin?: string | null; contentType?: string; who?: Identity; method?: string; body?: string | ReadableStream<Uint8Array> };
function call(route: Route, caseId: string, payload: unknown, init: Init = {}) {
  const url = new URL(`/operator/publication/${caseId}/${route}`, ORIGIN), headers = new Headers();
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  headers.set('content-type', init.contentType ?? 'application/json');
  const method = init.method ?? 'POST', body = method === 'GET' ? undefined : (init.body ?? JSON.stringify(payload));
  const request = new Request(url, { method, headers, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
  return dispatch(route, { request, url, params: { caseId }, locals: { identity: init.who ?? identity() } });
}
const code = async (r: Response) => ((await r.clone().json()) as { code: string }).code;
const identityOf = (s: CandidateSnapshot) => ({
  candidateId: s.link.candidate.candidateId, linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
  resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
  diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
});
const signoffBody = (o: { snap?: CandidateSnapshot; acks?: unknown; selfApproval?: boolean; operationId?: string; extra?: Record<string, unknown> } = {}) => {
  const s = o.snap ?? snapshot(), { candidateId, ...rest } = identityOf(s);
  return { operationId: o.operationId ?? op(), candidateId, identity: rest, acknowledgements: o.acks ?? [{ fingerprint: F_NEW, reason: 'Reviewed: synthetic page count differs as expected.' }], selfApproval: o.selfApproval ?? false, ...o.extra };
};
const signoffs = (db: SqliteD1) => db.rows<Record<string, unknown>>('SELECT * FROM pub_signoff');
const operations = (db: SqliteD1) => db.rows<Record<string, unknown>>('SELECT * FROM pub_operation');
async function signedOff(w: ReturnType<typeof world>, who = identity()) {
  const r = await call('signoffs', 'case-a', signoffBody(), { who });
  expect(r.status).toBe(201);
  return ((await r.json()) as { signoffId: string }).signoffId;
}

beforeEach(() => compose(null));

describe('availability and request admission come before any body, row or candidate read', () => {
  it('answers 503 when the parent has not composed the ports, and when any one port is null', async () => {
    world({ configured: false });
    expect((await call('signoffs', 'case-a', signoffBody())).status).toBe(503);
    for (const k of ['authorize', 'candidates', 'publisher', 'ledger', 'audit'] as const) {
      const w = world({ ports: { [k]: null } });
      const t = trackedBody(JSON.stringify(signoffBody()));
      const r = await call('signoffs', 'case-a', null, { body: t.stream });
      expect(r.status, k).toBe(503);
      expect(await code(r)).toBe('publication-unavailable');
      expect(t.state.pulled).toBe(0);
      expect(signoffs(w.db)).toHaveLength(0);
    }
  });

  it('refuses a cross-origin or originless POST with 403 before identity, body or state', async () => {
    for (const origin of ['https://evil.test', null]) {
      const w = world(), calls: string[] = [], t = trackedBody(JSON.stringify(signoffBody()));
      const r = await call('signoffs', 'case-a', null, { origin, body: t.stream, who: identity({ calls }) });
      expect(r.status).toBe(403);
      expect(await code(r)).toBe('cross-origin');
      expect(t.state.pulled + calls.length + w.calls.length + w.candidates.calls.length).toBe(0);
    }
  });

  it('refuses anonymous, wrong-client and revoked sessions with 401 before authorization or body', async () => {
    for (const who of [identity({ principal: null }), identity({ clientId: 'client-b' as never }), identity({ revoked: true })]) {
      const w = world(), t = trackedBody(JSON.stringify(signoffBody()));
      const r = await call('signoffs', 'case-a', null, { body: t.stream, who });
      expect(r.status).toBe(401);
      expect(t.state.pulled + w.calls.length + w.candidates.calls.length).toBe(0);
    }
  });

  it('checks revocation before authorization: a revoked session never reaches the grant check', async () => {
    const w = world(), calls: string[] = [];
    await call('publish', 'case-a', { operationId: op(), signoffId: 'x', expected: { kind: 'none' } }, { who: identity({ revoked: true, calls }) });
    expect(calls).toEqual(['revocation']);
    expect(w.calls).toHaveLength(0);
  });

  it('does not infer authority from a staff or global-admin identity: no explicit publish grant is a uniform 403', async () => {
    for (const route of ['signoffs', 'publish', 'withdraw'] as const) {
      const w = world(), t = trackedBody(JSON.stringify(signoffBody()));
      const r = await call(route, 'case-a', null, { body: t.stream, who: identity({ principal: STRANGER }) });
      expect(r.status, route).toBe(403);
      expect(await code(r)).toBe('forbidden');
      expect(t.state.pulled + w.candidates.calls.length + w.publisher.calls.length + signoffs(w.db).length + operations(w.db).length).toBe(0);
    }
    // a grant on another case does not reach this one, and an unknown case refuses identically
    world({ grants: [`${PUBLISHER.subject}:${CASE_B}`] });
    expect(await code(await call('signoffs', 'case-a', signoffBody()))).toBe('forbidden');
    expect(await code(await call('signoffs', 'case-zz', signoffBody()))).toBe('forbidden');
  });

  it('exposes only a human POST: no GET, PUT or DELETE handler exists on any publication route', () => {
    for (const r of Object.values(ROUTES)) expect(Object.keys(r).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(['POST']);
  });
});

describe('sign-off binds one exact, reviewable candidate', () => {
  it('records a durable, audited sign-off pinning link, submission, results, package, diagnostics and warning identity', async () => {
    const w = world(), s = snapshot();
    const r = await call('signoffs', 'case-a', signoffBody());
    expect(r.status).toBe(201);
    const [row] = signoffs(w.db);
    expect(row).toMatchObject({
      client_id: CLIENT, case_id: CASE_A, candidate_id: 'cand-0001', link_id: s.link.linkId, submission_revision_id: s.link.submissionRevisionId,
      submission_manifest_sha256: s.link.submissionManifestSha256, results_version: RV_NEW, manifest_sha256: s.link.candidate.manifestSha256,
      package_input_revision_id: 'inrev-1', diagnostics_sha256: s.validation.diagnosticsSha256, validator_version: 'validator-1', snapshot_revision: 'snap-1',
      signer_subject: PUBLISHER.subject, prepared_by_subject: PREPARER.subject, self_approval: 0, state: 'audited', invalidated_at: null,
    });
    expect(JSON.parse(row.warning_fingerprints as string)).toEqual([F_BASE, F_NEW].sort());
    expect(JSON.parse(row.acknowledgements as string)).toEqual([{ fingerprint: F_NEW, reason: 'Reviewed: synthetic page count differs as expected.' }]);
    expect(w.audit.events.map((e) => [e.action, e.version, e.outcome])).toEqual([['publication.signoff', RV_NEW, 'succeeded']]);
    expect(w.publisher.calls).toHaveLength(0); // signing off never publishes
  });

  const blocked: [string, Partial<CandidateSnapshot>, string][] = [
    ['an error', { validation: { ...snapshot().validation, errorFingerprints: ['d'.repeat(32)] } }, 'validation-failed'],
    ['a rejected import', { validation: { ...snapshot().validation, verdict: 'reject' } }, 'validation-failed'],
    ['an invalid required section', { requiredSections: [{ key: 'chronology', state: 'invalid' }] }, 'required-section'],
    ['an unsupported required section', { requiredSections: [{ key: 'chronology', state: 'valid' }, { key: 'x', state: 'unsupported' }] }, 'required-section'],
    ['a failed required preview', { requiredPreviews: [{ assetId: 'orig-1', state: 'failed' }] }, 'preview-not-ready'],
    ['a pending required preview', { requiredPreviews: [{ assetId: 'orig-1', state: 'pending' }] }, 'preview-not-ready'],
  ];
  for (const [what, change, expected] of blocked) it(`cannot sign off a candidate with ${what}`, async () => {
    const snap = snapshot(change), w = world({ snap });
    const r = await call('signoffs', 'case-a', signoffBody({ snap }));
    expect(r.status).toBe(422);
    expect(await code(r)).toBe(expected);
    expect(signoffs(w.db)).toHaveLength(0);
  });

  it('never trusts a boolean ready: a snapshot carrying `ready` is unreadable, and a request carrying it is invalid', async () => {
    const snap = { ...snapshot({ requiredSections: [{ key: 'chronology', state: 'invalid' }] }), ready: true } as CandidateSnapshot;
    let w = world({ snap });
    let r = await call('signoffs', 'case-a', signoffBody({ snap }));
    expect(r.status).toBe(503);
    expect(signoffs(w.db)).toHaveLength(0);
    w = world();
    r = await call('signoffs', 'case-a', signoffBody({ extra: { ready: true } }));
    expect(r.status).toBe(422);
    expect(signoffs(w.db)).toHaveLength(0);
  });

  const acks: [string, unknown, string][] = [
    ['no acknowledgement of a new warning', [], 'ack-incomplete'],
    ['an acknowledgement without a reason', [{ fingerprint: F_NEW, reason: '   ' }], 'ack-reason'],
    ['an acknowledgement of an already trusted warning', [{ fingerprint: F_NEW, reason: 'ok' }, { fingerprint: F_BASE, reason: 'ok' }], 'ack-not-exact'],
    ['an acknowledgement naming an unknown fingerprint', [{ fingerprint: F_NEW, reason: 'ok' }, { fingerprint: 'a'.repeat(32), reason: 'ok' }], 'ack-not-exact'],
    ['a duplicated acknowledgement', [{ fingerprint: F_NEW, reason: 'ok' }, { fingerprint: F_NEW, reason: 'again' }], 'ack-not-exact'],
  ];
  for (const [what, list, expected] of acks) it(`refuses ${what}`, async () => {
    const w = world();
    const r = await call('signoffs', 'case-a', signoffBody({ acks: list }));
    expect(r.status).toBe(422);
    expect(await code(r)).toBe(expected);
    expect(signoffs(w.db)).toHaveLength(0);
  });

  it('cannot waive an error by acknowledging it', async () => {
    const snap = snapshot({ validation: { ...snapshot().validation, errorFingerprints: ['d'.repeat(32)] } }), w = world({ snap });
    const r = await call('signoffs', 'case-a', signoffBody({ snap, acks: [{ fingerprint: F_NEW, reason: 'ok' }, { fingerprint: 'd'.repeat(32), reason: 'waive' }] }));
    expect(r.status).toBe(422);
    expect(signoffs(w.db)).toHaveLength(0);
  });

  it('refuses a stale review: any bound identity field that differs from the current snapshot is a 409', async () => {
    for (const field of ['snapshotRevision', 'diagnosticsSha256', 'linkId', 'submissionManifestSha256', 'manifestSha256', 'resultsVersion'] as const) {
      const w = world(), body = signoffBody();
      (body.identity as Record<string, string>)[field] = field === 'resultsVersion' ? RV_OLD : 'stale-0';
      const r = await call('signoffs', 'case-a', body);
      expect(r.status, field).toBe(409);
      expect(await code(r)).toBe('stale-candidate');
      expect(signoffs(w.db)).toHaveLength(0);
    }
  });

  it('refuses a candidate whose link names another case or client, as not found', async () => {
    const w = world();
    w.candidates.put(snapshot({ caseId: CASE_B }), CASE_A, 'cand-0001');
    const r = await call('signoffs', 'case-a', signoffBody());
    expect(r.status).toBe(404);
    expect(signoffs(w.db)).toHaveLength(0);
  });

  it('lets the preparer approve only through an explicit, recorded self-approval', async () => {
    let w = world();
    let r = await call('signoffs', 'case-a', signoffBody(), { who: identity({ principal: PREPARER }) });
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('self-approval-unconfirmed');
    r = await call('signoffs', 'case-a', signoffBody({ selfApproval: true }));
    expect(r.status).toBe(422); // a non-preparer cannot claim self-approval
    expect(signoffs(w.db)).toHaveLength(0);
    w = world();
    r = await call('signoffs', 'case-a', signoffBody({ selfApproval: true }), { who: identity({ principal: PREPARER }) });
    expect(r.status).toBe(201);
    expect(signoffs(w.db)[0]).toMatchObject({ self_approval: 1, signer_subject: PREPARER.subject, prepared_by_subject: PREPARER.subject });
  });

  it('a sign-off whose audit event did not persist is not effective; the same operation settles it on retry', async () => {
    const w = world(), body = signoffBody();
    w.audit.failNext = 1;
    let r = await call('signoffs', 'case-a', body);
    expect(r.status).toBe(503);
    expect(signoffs(w.db)[0]).toMatchObject({ state: 'recorded' });
    const id = signoffs(w.db)[0].signoff_id as string;
    r = await call('publish', 'case-a', { operationId: op(), signoffId: id, expected: { kind: 'none' } });
    expect(r.status).toBe(409);
    expect(w.publisher.calls).toHaveLength(0);
    r = await call('signoffs', 'case-a', body);
    expect(r.status).toBe(201);
    expect(signoffs(w.db)).toHaveLength(1);
    expect(signoffs(w.db)[0]).toMatchObject({ state: 'audited' });
  });

  it('refuses a reused operation id that carries a different request', async () => {
    const w = world(), body = signoffBody();
    expect((await call('signoffs', 'case-a', body)).status).toBe(201);
    const r = await call('signoffs', 'case-a', { ...body, acknowledgements: [{ fingerprint: F_NEW, reason: 'different words' }] });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('operation-reused');
    expect(signoffs(w.db)).toHaveLength(1);
  });
});

describe('publication is a CAS on the exact signed-off candidate', () => {
  it('publishes the signed-off version and audits it', async () => {
    const w = world(), signoffId = await signedOff(w);
    const r = await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(r.status).toBe(200);
    expect(w.publisher.current('case-a')).toEqual({ kind: 'published', resultsVersion: RV_NEW });
    expect(operations(w.db)[0]).toMatchObject({ kind: 'publish', state: 'audited', signoff_id: signoffId, results_version: RV_NEW });
    expect(w.audit.events.map((e) => e.action)).toEqual(['publication.signoff', 'publication.publish']);
  });

  it('an edit after sign-off invalidates it: publish is refused, the pointer is untouched and the sign-off stays void', async () => {
    const w = world(), signoffId = await signedOff(w);
    w.candidates.put(snapshot({ snapshotRevision: 'snap-2' }));
    let r = await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('signoff-stale');
    expect(w.publisher.calls).toHaveLength(0);
    expect(signoffs(w.db)[0].invalidated_at).not.toBeNull();
    w.candidates.put(snapshot()); // reverting the snapshot does not revive a void sign-off
    r = await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(r.status).toBe(409);
    expect(w.publisher.calls).toHaveLength(0);
  });

  it('a newly failed preview or a new warning since sign-off also invalidates it', async () => {
    for (const change of [{ requiredPreviews: [{ assetId: 'orig-1', state: 'failed' as const }] }, { trustedBaseline: [] }]) {
      const w = world(), signoffId = await signedOff(w);
      w.candidates.put(snapshot(change));
      const r = await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
      expect(r.status).toBe(409);
      expect(w.publisher.calls).toHaveLength(0);
    }
  });

  it('refuses a sign-off of another case', async () => {
    const w = world({ grants: [`${PUBLISHER.subject}:${CASE_A}`, `${PUBLISHER.subject}:${CASE_B}`] }), signoffId = await signedOff(w);
    const r = await call('publish', 'case-b', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(r.status).toBe(404);
    expect(w.publisher.calls).toHaveLength(0);
  });

  it('a stale expected pointer is a 409 conflict and the published version stays', async () => {
    const w = world(), signoffId = await signedOff(w);
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_OLD });
    const r = await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('publication-conflict');
    expect(w.publisher.current('case-a')).toEqual({ kind: 'published', resultsVersion: RV_OLD });
    expect(operations(w.db)[0]).toMatchObject({ state: 'refused' });
  });

  it('a failed publish keeps the old version and all user work, and the same operation can be retried', async () => {
    const w = world(), signoffId = await signedOff(w), operationId = op();
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_OLD });
    w.publisher.failNext = 'publish';
    const before = { originals: [...w.publisher.originals], work: [...w.publisher.userWork] };
    let r = await call('publish', 'case-a', { operationId, signoffId, expected: { kind: 'published', resultsVersion: RV_OLD } });
    expect(r.status).toBe(503);
    expect(w.publisher.current('case-a')).toEqual({ kind: 'published', resultsVersion: RV_OLD });
    expect({ originals: [...w.publisher.originals], work: [...w.publisher.userWork] }).toEqual(before);
    expect(operations(w.db)[0]).toMatchObject({ state: 'failed' });
    r = await call('publish', 'case-a', { operationId, signoffId, expected: { kind: 'published', resultsVersion: RV_OLD } });
    expect(r.status).toBe(200);
    expect(w.publisher.current('case-a')).toEqual({ kind: 'published', resultsVersion: RV_NEW });
  });
});

describe('an applied pointer change is always settled by retrying its operation', () => {
  it('a publish whose audit event failed is applied once; the retry audits it even after a later candidate edit', async () => {
    const w = world(), signoffId = await signedOff(w), body = { operationId: op(), signoffId, expected: { kind: 'none' } };
    w.audit.failNext = 1;
    let r = await call('publish', 'case-a', body);
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('audit-unavailable');
    expect(operations(w.db)[0]).toMatchObject({ state: 'applied' });
    w.candidates.put(snapshot({ snapshotRevision: 'snap-9' }));
    r = await call('publish', 'case-a', body);
    expect(r.status).toBe(200);
    expect(w.publisher.calls).toEqual([`publish:case-a:${RV_NEW}`]);
    expect(operations(w.db)[0]).toMatchObject({ state: 'audited' });
    expect(w.audit.events.map((e) => e.action)).toEqual(['publication.signoff', 'publication.publish']);
  });
});

describe('withdrawal removes results only', () => {
  it('needs explicit publish authority and a matching expected pointer', async () => {
    const w = world();
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_OLD });
    let r = await call('withdraw', 'case-a', { operationId: op(), resultsVersion: RV_OLD, expected: { kind: 'published', resultsVersion: RV_OLD } }, { who: identity({ principal: STRANGER }) });
    expect(r.status).toBe(403);
    // an expectation that is not "this version is published" is malformed; a stale one is a CAS conflict
    r = await call('withdraw', 'case-a', { operationId: op(), resultsVersion: RV_OLD, expected: { kind: 'none' } });
    expect(r.status).toBe(422);
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_NEW });
    r = await call('withdraw', 'case-a', { operationId: op(), resultsVersion: RV_OLD, expected: { kind: 'published', resultsVersion: RV_OLD } });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('publication-conflict');
    expect(w.publisher.current('case-a')).toEqual({ kind: 'published', resultsVersion: RV_NEW });
  });

  it('withdraws the published version, audits it, and leaves originals and user work in place', async () => {
    const w = world();
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_OLD });
    const before = { originals: [...w.publisher.originals], work: [...w.publisher.userWork] };
    const r = await call('withdraw', 'case-a', { operationId: op(), resultsVersion: RV_OLD, expected: { kind: 'published', resultsVersion: RV_OLD } });
    expect(r.status).toBe(200);
    expect(w.publisher.current('case-a')).toEqual({ kind: 'withdrawn', resultsVersion: RV_OLD });
    expect({ originals: [...w.publisher.originals], work: [...w.publisher.userWork] }).toEqual(before);
    expect(w.publisher.calls).toEqual([`withdraw:case-a:${RV_OLD}`]);
    expect(operations(w.db)[0]).toMatchObject({ kind: 'withdraw', state: 'audited', signoff_id: null });
    expect(w.audit.events.map((e) => [e.action, e.version])).toEqual([['publication.withdraw', RV_OLD]]);
  });

  it('refuses a withdrawal whose version is not the expected published one', async () => {
    const w = world();
    w.publisher.pointer.set('case-a', { kind: 'published', resultsVersion: RV_OLD });
    const r = await call('withdraw', 'case-a', { operationId: op(), resultsVersion: RV_NEW, expected: { kind: 'published', resultsVersion: RV_OLD } });
    expect(r.status).toBe(422);
    expect(w.publisher.calls).toHaveLength(0);
  });
});

describe('the D1 ledger is write-once', () => {
  it('refuses rewriting a bound sign-off field, deleting a sign-off or operation, and REPLACE', async () => {
    const w = world(), signoffId = await signedOff(w);
    await call('publish', 'case-a', { operationId: op(), signoffId, expected: { kind: 'none' } });
    expect(() => w.db.exec('UPDATE pub_signoff SET results_version = ? WHERE signoff_id = ?', RV_OLD, signoffId)).toThrow();
    expect(() => w.db.exec('UPDATE pub_signoff SET acknowledgements = ? WHERE signoff_id = ?', '[]', signoffId)).toThrow();
    expect(() => w.db.exec("UPDATE pub_signoff SET state = 'recorded' WHERE signoff_id = ?", signoffId)).toThrow();
    expect(() => w.db.exec('DELETE FROM pub_signoff WHERE signoff_id = ?', signoffId)).toThrow();
    expect(() => w.db.exec('DELETE FROM pub_operation')).toThrow();
    expect(() => w.db.exec("UPDATE pub_operation SET state = 'pending'")).toThrow();
    expect(() => w.db.exec('INSERT OR REPLACE INTO pub_signoff SELECT * FROM pub_signoff')).toThrow();
    expect(signoffs(w.db)).toHaveLength(1);
  });

  it('allows only the invalidation of a sign-off, once', async () => {
    const w = world(), signoffId = await signedOff(w);
    w.db.exec("UPDATE pub_signoff SET invalidated_at = '2026-10-25T07:00:00.000Z', invalidated_reason = 'edited' WHERE signoff_id = ?", signoffId);
    expect(() => w.db.exec('UPDATE pub_signoff SET invalidated_at = NULL, invalidated_reason = NULL WHERE signoff_id = ?', signoffId)).toThrow();
  });
});
