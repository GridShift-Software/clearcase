// NATIVE24: the real GRS-137 intake controller (via its hosted route modules) composed with the real upload authorizer.
// The submission repository and the original store are the 137 unit doubles, so this is component evidence only.
import { describe, expect, it } from 'vitest';
import type { Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { createUploadAuthorizer } from '../../../src/lib/tenancy/upload-capability.ts';
import { MemoryOriginals, SqliteD1, hex, syntheticPdf, trackedBody } from '../../hosted-smoke/intake/doubles.ts';
import { MIGRATIONS, compose, dispatch, repositoryFor } from '../../hosted-smoke/intake/harness.ts';
import { CASE_1, CASE_2, CLIENT_A, SESSION, SESSION_2, client, staff, world } from './world.ts';

const ORIGIN = 'https://client-a.clearcase.test', USER = client('user_a');
const BUDGET = { maxMetadataBytes: 2048, maxFileBytes: 4096 };
type W = Awaited<ReturnType<typeof world>>;

function setup(w: W, o: { authorizer?: 'real' | 'none' } = {}) {
  const db = new SqliteD1(MIGRATIONS), originals = new MemoryOriginals(), repository = repositoryFor(db);
  const authorizeUpload = o.authorizer === 'none' ? createUploadAuthorizer(null) : w.authorize;
  compose({ clientId: CLIENT_A, budget: BUDGET, authorizeUpload, originals, repository, now: () => new Date('2026-10-25T08:00:00.000Z') });
  return { db, originals };
}
const who = (w: W, p: Principal, sessionId: SessionId = SESSION): Identity => ({
  kind: 'verified', principal: p, sessionId, clientId: CLIENT_A,
  checkRevocation: () => w.session({ principal: p, sessionId }),
  authorize: (a) => w.caseAuthorizer.authorizeCase({ principal: p, sessionId, caseId: a.caseId, operation: a.operation }),
});
let seq = 0;
const post = (caseId: string, identity: Identity, body: BodyInit | ReadableStream<Uint8Array>) => {
  const url = new URL(`/client/intake/${caseId}/submissions`, ORIGIN);
  const request = new Request(url, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
  return dispatch('submissions', 'POST', { request, url, params: { caseId }, locals: { identity } });
};
const get = (caseId: string, identity: Identity) => {
  const url = new URL(`/client/intake/${caseId}/submissions`, ORIGIN);
  return dispatch('submissions', 'GET', { request: new Request(url, { headers: { origin: ORIGIN } }), url, params: { caseId }, locals: { identity } });
};
const declaration = () => { const bytes = syntheticPdf(); return JSON.stringify({ operationId: `op-${String(++seq).padStart(4, "0")}-0b7c2f3e1d2a4c5b`, path: 'Letters/claim.pdf', size: bytes.byteLength, sha256: hex(bytes), mediaType: 'application/pdf' }); };

describe('the 137 intake with the real upload authorizer', () => {
  it('admits only explicit case access plus an explicit upload grant, and answers every other case with one 403 that never pulls the body', async () => {
    const w = await world();
    w.seedCase(USER, 'editor', CASE_1);
    w.seedCase(USER, 'viewer', CASE_2);
    w.seedCase(staff('s'), 'editor', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    const t = setup(w);
    expect((await post(CASE_1, who(w, USER), declaration())).status).toBe(201);
    const refused: string[] = [];
    for (const [c, p] of [[CASE_2, USER], [CASE_1, staff('s')], ['case-unknown', USER]] as const) {
      const tracked = trackedBody(new TextEncoder().encode(declaration()));
      const r = await post(c, who(w, p), tracked.stream);
      expect(r.status).toBe(403);
      expect(tracked.state.pulled).toBe(0);
      refused.push(await r.text());
    }
    expect(new Set(refused).size).toBe(1);
    expect(refused[0]).not.toMatch(/case-|grant|upload grant|revoked/i);
    expect(t.originals).toBeTruthy();
  });
  it('a revoked grant refuses the next request at once, the same 403 as an unknown case', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    const g = await w.issue(USER, CASE_1, 'op-1');
    if (g.kind !== 'applied') throw new Error('setup');
    setup(w);
    expect((await post(CASE_1, who(w, USER), declaration())).status).toBe(201);
    await w.provisioning.revoke({ operator: 'provisioning-run-1', operationId: 'rev-1', grantId: g.grant.grantId, expectedVersion: g.grant.version });
    const revoked = await post(CASE_1, who(w, USER), declaration());
    const unknown = await post('case-unknown', who(w, USER), declaration());
    expect(revoked.status).toBe(403);
    expect(await revoked.text()).toBe(await unknown.text());
  });
  it('a revoked session is 401, a backend fault and an unconfigured authorizer are 503, and neither allows', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    setup(w);
    w.revoked.add(SESSION);
    expect((await post(CASE_1, who(w, USER), declaration())).status).toBe(401);
    w.state.uploadsFail = true;
    expect((await post(CASE_1, who(w, USER, SESSION_2), declaration())).status).toBe(503);
    w.state.uploadsFail = false;
    setup(w, { authorizer: 'none' });
    expect((await post(CASE_1, who(w, USER, SESSION_2), declaration())).status).toBe(503);
  });
  it('an upload grant alone reads nothing through the intake: listing needs ordinary case access', async () => {
    const w = await world();
    await w.issue(USER, CASE_1, 'op-1');
    setup(w);
    expect((await get(CASE_1, who(w, USER))).status).toBe(404);
  });
});
