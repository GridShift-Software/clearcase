// Production SQL on file-backed SQLite with a D1-shaped transport; NOT native D1/Clerk acceptance.
import { afterEach, expect, it } from 'vitest';
import { d1ReadinessFence, type ReadinessObservation } from '../../../src/lib/publication/hosted/readiness-fence.ts';
import { createPublicationReadiness, type PublicationReadinessPorts } from '../../../src/lib/publication/hosted/readiness.ts';
import { Harness, CLIENT, CASE, PRINCIPAL, SESSION, NOW, insert } from '../../publication/hosted/atomic-d1/harness.ts';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';
import { world } from './fixtures.ts';
import { resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';

const opened: Harness[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.close(); });
async function fixture(audited = true) {
  const h = new Harness(); opened.push(h);
  const publisher = h.db.rows<Record<string, string | number | null>>('SELECT * FROM tenant_case_grants')[0];
  insert(h.db, 'tenant_case_grants', { ...publisher, grant_id: 'grant-content', role: 'viewer', slot: 'content', created_operation_id: 'create-content' });
  const signed = await h.signed(undefined, undefined, audited);
  const snapshot = (await h.snapshot(signed.identity.candidateId))!;
  const signoff = (await h.ledger.signoff({ clientId: CLIENT, caseId: CASE, signoffId: signed.signoffId }))!;
  const observation: ReadinessObservation = { clientId: CLIENT, caseId: CASE, principal: PRINCIPAL, sessionId: SESSION, snapshot, signoff };
  const fence = d1ReadinessFence({ db: h.db, clientId: CLIENT });
  const ports: { -readonly [K in keyof PublicationReadinessPorts]: PublicationReadinessPorts[K] } = { ...h.ports(), readinessFence: fence };
  const identity = h.identity();
  const url = new URL(`https://synthetic.invalid/operator/publication/${CASE}/readiness?candidateId=${signed.identity.candidateId}&signoffId=${signed.signoffId}`);
  const request = { request: new Request(url), url, params: { caseId: CASE }, identity };
  return { h, signed, observation, fence, ports, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const mutations = {
  'ledger-only invalidation': (f: Fixture) => f.h.editor.exec("UPDATE pub_signoff SET invalidated_at = ?, invalidated_reason = 'synthetic' WHERE signoff_id = ?", NOW, f.signed.signoffId),
  'baseline without generation change': (f: Fixture) => f.h.editor.exec('INSERT INTO rs_trusted_fingerprint(case_id, fingerprint) VALUES (?, ?)', CASE, 'b'.repeat(32)),
  'candidate generation': (f: Fixture) => f.h.editor.exec('UPDATE pub_candidate_generation SET generation = generation + 1'),
  'preview dependency': (f: Fixture) => insert(f.h.editor, 'rs_preview', { version_id: f.signed.identity.resultsVersion, asset_id: 'synthetic-preview', sha256: 'a'.repeat(64), size: 1, media_type: 'application/pdf', filename: 'synthetic.pdf', object_key: 'synthetic/immutable-preview' }),
  'publish grant': (f: Fixture) => f.h.revoke(),
  'preview grant': (f: Fixture) => f.h.editor.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ?, revoked_operation_id = 'revoke-content', version = version + 1 WHERE grant_id = 'grant-content'", NOW),
  'local session': (f: Fixture) => insert(f.h.editor, 'pub_session_revocation', { client_id: CLIENT, issuer: PRINCIPAL.issuer, session_id: SESSION, revoked_at: NOW }),
};
const statusOf = (name: string) => name === 'local session' ? 401 : name.endsWith('grant') ? 403 : 409;

it('coherently matches the whole observation in one primary SQL statement, without publication writes', async () => {
  const f = await fixture(); f.h.db.sessions.length = 0;
  const before = canonicalJson(f.observation);
  expect(await f.fence.check(f.observation)).toBe('current');
  expect(f.h.db.sessions).toEqual(['first-primary']);
  expect(canonicalJson(f.observation)).toBe(before);
  expect(f.h.pointer()).toBeNull(); expect(f.h.receiptCount()).toBe(0);
  const response = await createPublicationReadiness(f.ports).read(f.request);
  expect(response.status).toBe(200);
  expect((await response.json()).signoff).toMatchObject({ state: 'audited', invalidated: false, blockers: [] });
  expect(f.h.events.map(e => e.action)).toEqual(['publication.readiness.intent', 'publication.readiness.release-intent']);
});

it.each(Object.keys(mutations) as (keyof typeof mutations)[])('refuses %s changed during the final candidate await', async name => {
  const f = await fixture(); let reads = 0;
  const read = f.ports.candidates!.read;
  f.ports.candidates = { read: async a => {
    const snapshot = await read(a);
    if (++reads === 2) mutations[name](f);
    return snapshot;
  } };
  const response = await createPublicationReadiness(f.ports).read(f.request);
  expect(response.status).toBe(statusOf(name));
  expect(Object.keys(await response.json()).sort()).toEqual(['code', 'message']);
  expect(f.h.events.at(-1)).toMatchObject({ action: 'publication.readiness.refused', outcome: statusOf(name) === 409 ? 'refused' : 'denied' });
  expect(f.h.events.some(e => e.action === 'publication.readiness.read' && e.outcome === 'succeeded')).toBe(false);
  expect(f.h.pointer()).toBeNull(); expect(f.h.receiptCount()).toBe(0);
});

it.each(['release audit', 'fourth authority', 'last signoff', 'SQL submission'])('fences mutations after %s', async point => {
  const f = await fixture(); let previews = 0, ledgerReads = 0;
  const mutate = () => mutations['ledger-only invalidation'](f);
  if (point === 'release audit') {
    const append = f.ports.audit!.append;
    f.ports.audit = { append: async e => { const r = await append(e); if (e.action === 'publication.readiness.release-intent') mutate(); return r; } };
  }
  if (point === 'fourth authority') f.request.identity.authorize = async () => { if (++previews === 4) mutate(); };
  if (point === 'last signoff') {
    const read = f.ports.ledger!.signoff;
    f.ports.ledger = { ...f.ports.ledger!, signoff: async a => { const s = await read(a); if (++ledgerReads === 2) mutate(); return s; } };
  }
  if (point === 'SQL submission') f.ports.readinessFence = d1ReadinessFence({ clientId: CLIENT, db: {
    withSession(c) { mutate(); return f.h.db.withSession(c); },
  } });
  expect((await createPublicationReadiness(f.ports).read(f.request)).status).toBe(409);
});

it.each(['recorded', 'invalidated', 'stale identity'] as const)('returns truthful blockers for a stable %s sign-off', async state => {
  const f = await fixture(state !== 'recorded');
  if (state === 'invalidated') mutations['ledger-only invalidation'](f);
  if (state === 'stale identity') {
    const old = await f.h.signed(f.signed.identity.candidateId, 'signoff-operation-0002', true, 'd1:999');
    f.request.url.searchParams.set('signoffId', old.signoffId);
  }
  const response = await createPublicationReadiness(f.ports).read(f.request);
  expect(response.status).toBe(200);
  expect((await response.json()).signoff.blockers).toContain(state === 'stale identity' ? 'signoff-stale' : 'signoff-not-effective');
});

it.each(['baseline without generation change', 'candidate generation', 'preview dependency'] as const)('checks %s even when no sign-off was requested', async name => {
  const f = await fixture(); f.observation.signoff = null;
  expect(await f.fence.check(f.observation)).toBe('current');
  mutations[name](f);
  expect(await f.fence.check(f.observation)).toBe('stale');
});

it.each(['warnings', 'acknowledgements', 'invalidation reason', 'signer', 'identity', 'audit'] as const)('compares exact sign-off %s rather than saved effective booleans', async field => {
  const f = await fixture(), so = f.observation.signoff!;
  if (field === 'warnings') f.observation.signoff = { ...so, warningFingerprints: ['b'.repeat(32)] };
  if (field === 'acknowledgements') f.observation.signoff = { ...so, acknowledgements: [{ fingerprint: 'b'.repeat(32), reason: 'Synthetic reason' }] };
  if (field === 'invalidation reason') f.observation.signoff = { ...so, invalidatedReason: 'synthetic' };
  if (field === 'signer') f.observation.signoff = { ...so, signer: { ...so.signer, subject: 'other' } };
  if (field === 'identity') f.observation.signoff = { ...so, snapshotRevision: 'd1:999' };
  if (field === 'audit') f.observation.signoff = { ...so, auditEvent: { ...so.auditEvent, eventId: 'other' } };
  expect(await f.fence.check(f.observation)).toBe('stale');
});

it('compares native warning fingerprints and refuses crossed snapshot scope', async () => {
  const f = await fixture();
  const snapshot = f.observation.snapshot;
  f.observation.signoff = null;
  f.observation.snapshot = { ...snapshot, validation: { ...snapshot.validation, warningFingerprints: ['b'.repeat(32)] } };
  expect(await f.fence.check(f.observation)).toBe('stale');
  f.observation.snapshot = { ...snapshot, link: { ...snapshot.link, caseId: 'another-case' as typeof CASE } };
  expect(await f.fence.check(f.observation)).toBe('unavailable');
});

it('detects recorded-to-audited settlement independently of candidate generation', async () => {
  const f = await fixture(false);
  await f.h.ledger.settleSignoff({ clientId: CLIENT, caseId: CASE, signoffId: f.signed.signoffId });
  expect(await f.fence.check(f.observation)).toBe('stale');
});

it.each(['unaudited candidate', 'superseded', 'withdrawn', 'crossed DB', 'wrong issuer', 'wrong subject', 'revoked session', 'expired publish', 'expired preview', 'pending preview', 'invalid expiry'] as const)('refuses native eligibility or authority: %s', async variant => {
  const f = await fixture();
  let expected = 'stale';
  if (variant === 'unaudited candidate') {
    const cid = f.h.candidate('2', null, false);
    // All candidate pins match; only durable audit settlement is absent.
    f.observation.signoff = null;
    f.observation.snapshot = { ...f.observation.snapshot, link: { ...f.observation.snapshot.link, linkId: 'link-2', candidate: { ...f.observation.snapshot.link.candidate, candidateId: cid, resultsVersion: resultsVersion(`sha256:${'2'.repeat(64)}`), manifestSha256: sha256('2'.repeat(64)) } } };
  }
  if (variant === 'superseded') f.h.supersede(f.signed.identity.candidateId, f.h.candidate('2', f.signed.identity.candidateId));
  if (variant === 'withdrawn') insert(f.h.editor, 'rs_version_withdrawal', { version_id: f.signed.identity.resultsVersion, case_id: CASE, withdrawn_at: NOW });
  if (variant === 'crossed DB') { f.h.editor.exec("UPDATE rs_storage_identity SET client_id = 'other-client'"); expected = 'unavailable'; }
  if (variant === 'wrong issuer' || variant === 'wrong subject') {
    f.observation.principal = { ...PRINCIPAL, [variant === 'wrong issuer' ? 'issuer' : 'subject']: 'other' }; expected = 'forbidden';
  }
  if (variant === 'revoked session') { mutations['local session'](f); expected = 'invalid-session'; }
  if (variant.startsWith('expired') || variant === 'invalid expiry') {
    f.h.editor.exec('UPDATE tenant_case_grants SET expires_at = ? WHERE grant_id = ?', variant === 'invalid expiry' ? 'garbage' : '2000-01-01T00:00:00Z', variant === 'expired publish' ? 'grant-publisher-1' : 'grant-content'); expected = 'forbidden';
  }
  if (variant === 'pending preview') { f.h.editor.exec("UPDATE tenant_case_grants SET state = 'pending' WHERE grant_id = 'grant-content'"); expected = 'forbidden'; }
  expect(await f.fence.check(f.observation)).toBe(expected);
  if (variant === 'unaudited candidate') {
    const intent = f.h.db.rows<Record<string, string>>('SELECT client_id, case_id, candidate_id, event_id FROM native_candidate_audit_intent WHERE candidate_id = ?', 'candidate-2')[0];
    insert(f.h.editor, 'native_candidate_audit_settlement', intent);
    expect(await f.fence.check(f.observation)).toBe('current');
  }
});

it.each(['missing', 'wrong protocol', 'throws', 'malformed result', 'SQL fault', 'missing schema'] as const)('releases no metadata on %s fence', async variant => {
  const f = await fixture();
  if (variant === 'missing') delete f.ports.readinessFence;
  if (variant === 'wrong protocol') f.ports.readinessFence = { ...f.fence, protocol: 'wrong' as never };
  if (variant === 'throws') f.ports.readinessFence = { ...f.fence, check: async () => { throw new Error('synthetic'); } };
  if (variant === 'malformed result') f.ports.readinessFence = { ...f.fence, check: async () => true as never };
  if (variant === 'SQL fault') f.h.db.failSql = /WITH o AS/;
  if (variant === 'missing schema') f.h.db.sqlite.exec('DROP TABLE pub_session_revocation');
  const response = await createPublicationReadiness(f.ports).read(f.request);
  expect(response.status).toBe(503);
  expect(Object.keys(await response.json()).sort()).toEqual(['code', 'message']);
});

it('missing fence is unavailable before any metadata access', async () => {
  const w = world(); w.ports = { ...w.ports, readinessFence: null };
  expect((await createPublicationReadiness(w.ports).read(w.request())).status).toBe(503);
  expect(w.reads).toBe(0);
});

it('refusal audit failure cannot release metadata or claim completed success', async () => {
  const f = await fixture();
  f.ports.readinessFence = { ...f.fence, check: async () => 'stale' };
  const append = f.ports.audit!.append;
  f.ports.audit = { append: async e => { if (e.action === 'publication.readiness.refused') throw new Error('synthetic'); return append(e); } };
  const r = await createPublicationReadiness(f.ports).read(f.request);
  expect(r.status).toBe(503); expect((await r.json()).code).toBe('audit-unavailable');
  expect(f.h.events.map(e => e.action)).toEqual(['publication.readiness.intent', 'publication.readiness.release-intent']);
});

it('linearizes before a legitimate subsequent change; no port is awaited after successful fence', async () => {
  const f = await fixture();
  const check = f.fence.check;
  f.ports.readinessFence = { ...f.fence, check: async o => {
    const result = await check(o);
    mutations['ledger-only invalidation'](f);
    const unexpected = async (): Promise<never> => { throw new Error('post-fence port call'); };
    f.ports.audit = { append: unexpected }; f.ports.candidates = { read: unexpected };
    f.ports.ledger = { ...f.ports.ledger!, signoff: unexpected };
    f.ports.authorize = unexpected; f.request.identity.authorize = unexpected; f.request.identity.checkRevocation = unexpected;
    return result;
  } };
  const r = await createPublicationReadiness(f.ports).read(f.request);
  expect(r.status).toBe(200); expect((await r.json()).signoff.invalidated).toBe(false);
  expect(await f.fence.check(f.observation)).toBe('stale');
});
