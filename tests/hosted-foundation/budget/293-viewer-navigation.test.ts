// GRS-293: the standalone original viewer through the real hostedServices composition, as a hard load and as SvelteKit's
// client-side data request (`/view/__data.json`). Both are the same page view: both read the case through the request's
// one lookup, so a viewer's write-control snapshot says no and an editor's says yes, with the same D1 count and no added
// grant query. A note write is still authorized afresh and refused for a viewer, with its denial audited; a person
// without live authority (another case, another client, an expired or revoked grant) is refused on
// both forms of the page. Synthetic SQLite and R2 doubles and invented values only: not evidence of D1, Clerk or a Worker.
import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: { CLEARCASE_ASSET_TICKET_KEY: 'k'.repeat(64) } }));
import { readFileSync } from 'node:fs';
import { isHttpError } from '@sveltejs/kit';
import { hostedServices, requestPage } from '../../../src/lib/server/runtime/hosted/services.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { load } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.server.ts';
import * as pageNotes from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/notes/+server.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../native-runtime-config/harness.ts';
import { counters, countedD1, hostedWorld } from './harness.ts';
import { MIGRATION } from '../provisioning/world.ts';
import { bundleLinks } from '../../../src/lib/views/bundles/links.hosted.ts';
import { hrefOf } from '../../../src/lib/views/bundles/links.ts';
import { viewerPageHref } from '../../../src/lib/viewer/hosted/page-link.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const ISSUER = instances['client-a'].iss;
/** One case-a grant row for `subject`, as the grants migration stores it: active unless revoked, expiring if given. */
const GRANT = `INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at,expires_at,revoked_operation_id,revoked_at)
  VALUES (?,'client-a','case','case-a',?,?,'client',?,'content',?,1,?,'[]','seed','seed','2001-01-01T00:00:00.000Z',?,?,?)`;
const grant = (subject: string, role: string, o: { expiresAt?: string; revoked?: boolean } = {}) =>
  [`g-${subject}`, ISSUER, subject, role, o.revoked ? 'revoked' : 'active', `seed-${subject}`, o.expiresAt ?? null,
    o.revoked ? `revoke-${subject}` : null, o.revoked ? '2001-01-01T00:00:01.000Z' : null] as const;

async function world() {
  const w = await hostedWorld();
  w.db.sqlite.exec(MIGRATION);
  w.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
  w.db.exec("UPDATE rs_original SET etag = '\"synthetic-etag\"', media_family = 'pdf' WHERE etag IS NULL");
  const [assetId] = w.db.rows<{ ref: string }>("SELECT ref FROM rs_document WHERE version_id = ? AND json_extract(state_json, '$.original.sha256') IS NOT NULL ORDER BY ord LIMIT 1", w.resultsVersion!).map((r) => r.ref);
  for (const [subject, role, o] of [['v293', 'viewer', {}], ['e293', 'editor', {}],
    ['x293', 'editor', { expiresAt: '2001-01-02T00:00:00.000Z' }], ['r293', 'editor', { revoked: true }]] as const)
    w.db.exec(GRANT, ...grant(subject, role, o));
  const c = counters(), counted = countedD1(w.db, c);
  Object.assign(w.db, { withSession: () => counted });
  const sessions = { get: async () => null, put: async () => {} };
  const file = planNativeRuntimeConfig(exampleInput()).clients.find((f) => f.clientId === 'client-a')!;
  const pending: Promise<void>[] = [];
  const env = runtimeEnv(file, { DB: counted, BUCKET: w.bucket, CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: sessions });
  const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  await provisionAuditBinding({ db: w.db, config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [ISSUER, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
  const cookieOf = async (subject: string, clientId = 'client-a') => {
    const config = { key: 'a'.repeat(64), clientId, issuer: ISSUER, origin: ORIGIN, sessions };
    return `__Host-clearcase_session=${await signAppSession(config, await mintAppSession(config, { sid: `sid-${subject}`, subject, name: 'Synthetic person' }))}`;
  };
  const pagePath = `/cases/case-a/originals/${encodeURIComponent(assetId!)}/view`;
  /** One request's services, then the page's load, as SvelteKit runs them: a data request's load sees the page's URL. */
  const open = async (subject: string, data: boolean, o: { clientId?: string; caseId?: string; href?: string } = {}) => {
    const caseId = o.caseId ?? 'case-a';
    const page = new URL(o.href ?? `${pagePath.replace('case-a', caseId)}?page=2&zoom=fit`, ORIGIN);
    const dataUrl = new URL(`${page.pathname}/__data.json${page.search}`, ORIGIN);
    dataUrl.searchParams.set('x-sveltekit-invalidated', '01');
    const request = new Request(data ? dataUrl : page, { headers: { cookie: await cookieOf(subject, o.clientId) } });
    await Promise.all(pending); // an earlier request's deferred read audit is not this request's D1 call
    c.reset();
    const ready = await hostedServices(request, env, { waitUntil: (p) => pending.push(p) });
    expect(ready.ready).toBe(true);
    try {
      const value = (await load({ locals: ready.services, params: { caseId, assetId: assetId! }, url: page } as never)) as { canWrite: boolean; requestedPage: string | null; view: { state: string } };
      return { value, d1: c.d1, status: 200 };
    } catch (e) {
      if (isHttpError(e)) return { value: null, d1: c.d1, status: e.status };
      throw e;
    }
  };
  /** A page note POST through hostedServices: not a page view, so write-user-work is checked afresh and fails closed. */
  const write = async (subject: string) => {
    const url = `${ORIGIN}/cases/case-a/originals/${encodeURIComponent(assetId!)}/notes`;
    const body = JSON.stringify({ page: 1, body: 'Synthetic page note', operationId: `op-${subject}` });
    const request = new Request(url, { method: 'POST', body, headers: { cookie: await cookieOf(subject), origin: ORIGIN, 'content-type': 'application/json', 'content-length': String(body.length) } });
    const ready = await hostedServices(request, env, { waitUntil: (p) => pending.push(p) });
    try {
      return (await (pageNotes.POST as (e: never) => Promise<Response>)({ locals: ready.services, params: { caseId: 'case-a', assetId: assetId! }, request, url: new URL(url) } as never)).status;
    } catch (e) {
      if (isHttpError(e)) return e.status;
      throw e;
    }
  };
  const events = (action: string, outcome: string) => w.db.rows<{ actor_key: string }>('SELECT actor_key FROM native_audit_events WHERE action = ? AND outcome = ?', action, outcome);
  return { ...w, assetId: assetId!, pagePath, open, write, events, settle: () => Promise.all(pending), async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}

describe('293 the request classification', () => {
  it("an original viewer's data request is the same page view as its hard load, and carries the same original", () => {
    for (const path of ['/cases/c/originals/a%2Fb/view', '/cases/c/originals/a%2Fb/view/__data.json'])
      expect(requestPage('GET', path)).toEqual({ pageRequest: true, versionPost: false, originalSegment: 'a%2Fb' });
    expect(requestPage('GET', '/cases/c/notes/__data.json')).toMatchObject({ pageRequest: true, originalSegment: null });
    expect(requestPage('POST', '/cases/c/v/rv/chronology/original/r1')).toEqual({ pageRequest: false, versionPost: true, originalSegment: 'r1' });
  });
  it('byte routes, note endpoints, writes and look-alike paths are not page views', () => {
    for (const [method, path] of [['GET', '/cases/c/originals/a'], ['GET', '/cases/c/originals/a/notes'], ['POST', '/cases/c/originals/a/notes'],
      ['GET', '/cases/c/v/rv/assets/a'], ['GET', '/cases/c/originals/a/view/x'], ['GET', '/cases/c/originals/a/view/__data.jsonx'], ['POST', '/cases/c/originals/a/view']])
      expect(requestPage(method!, path!), `${method} ${path}`).toMatchObject({ pageRequest: false, originalSegment: null });
  });
});

describe('293 the original viewer through hostedServices', () => {
  it('a legacy intake original without delivery metadata remains readable on both page-load paths', async () => {
    const w = await world();
    try {
      w.db.exec('UPDATE rs_original SET etag = NULL, media_family = NULL');
      for (const data of [false, true]) {
        const r = await w.open('v293', data);
        expect(r.status).toBe(200);
        expect(r.value).toMatchObject({ view: { state: 'available' }, canWrite: false });
      }
    } finally { await w.cleanup(); }
  });

  it('hard load and data request give a viewer no write controls and an editor all, at the same D1 count', async () => {
    const w = await world();
    try {
      const seen: Record<string, { canWrite: boolean; d1: number }> = {};
      for (const [who, subject] of [['viewer', 'v293'], ['editor', 'e293']] as const)
        for (const data of [false, true]) {
          const r = await w.open(subject, data);
          expect(r.status).toBe(200);
          expect(r.value).toMatchObject({ view: { state: 'available' }, requestedPage: '2' });
          seen[`${who} ${data ? 'data' : 'hard'}`] = { canWrite: r.value!.canWrite, d1: r.d1 };
        }
      expect(seen).toEqual({
        'viewer hard': { canWrite: false, d1: 1 }, 'viewer data': { canWrite: false, d1: 1 },
        'editor hard': { canWrite: true, d1: 1 }, 'editor data': { canWrite: true, d1: 1 },
      });
    } finally { await w.cleanup(); }
  });

  it("a viewer's note write is still refused afresh and its denial audited; an editor's is written", async () => {
    const w = await world();
    try {
      expect(await w.write('v293')).toBe(403);
      await w.settle();
      expect(w.events('case.write-user-work', 'denied').length).toBe(1);
      expect(await w.write('e293')).toBe(201);
    } finally { await w.cleanup(); }
  });

  it('no live authority is refused on both the hard load and the data request, with the denial audited', async () => {
    const w = await world();
    try {
      for (const data of [false, true]) {
        const before = w.events('case.read-original', 'denied').length;
        for (const [label, subject, o] of [['no grant', 'nobody293', {}], ['expired grant', 'x293', {}], ['revoked grant', 'r293', {}], ['another case', 'e293', { caseId: 'case-b' }]] as const) {
          const r = await w.open(subject, data, o);
          expect(r.value, `${label} ${data}`).toBeNull();
          expect([403, 404], `${label} ${data}`).toContain(r.status);
        }
        await w.settle();
        expect(w.events('case.read-original', 'denied').length - before, `denials ${data}`).toBe(4);
        // Another client's session never reaches the case (a revoked app session is refused before services: session-refresh tests).
        for (const [label, subject, o] of [['another client', 'e293', { clientId: 'client-b' }]] as const) {
          const r = await w.open(subject, data, o);
          expect(r.value, `${label} ${data}`).toBeNull();
          expect(r.status, `${label} ${data}`).toBe(401);
        }
      }
    } finally { await w.cleanup(); }
  });
});

describe('293 page links reach the requested page of the native viewer', () => {
  it('a CaseLines page link and a document Open-at-page link open page 2, on a hard load and a data request alike', async () => {
    const w = await world();
    try {
      const { files } = bundleLinks({ paths: { 'PLEADINGS/Synthetic bundle.pdf': { ref: w.assetId } } } as never, 'case-a');
      const caselines = hrefOf(w.resultsVersion!, files, { ref: w.assetId, page: null }, 2)!;
      const openAtPage = viewerPageHref(`${w.pagePath}?zoom=fit`, 2);
      expect(caselines).toBe(`${w.pagePath}?page=2`);
      expect(openAtPage).toBe(`${w.pagePath}?zoom=fit&page=2`);
      for (const href of [caselines, openAtPage])
        for (const data of [false, true]) {
          const r = await w.open('v293', data, { href });
          expect(r.value, `${href} ${data}`).toMatchObject({ view: { state: 'available' }, requestedPage: '2', canWrite: false });
        }
      // The viewer, not the link, judges a page: an invalid or out-of-range request reaches it unchanged to be reported.
      for (const bad of ['0', 'two', '99999']) expect((await w.open('v293', true, { href: `${w.pagePath}?page=${bad}` })).value?.requestedPage).toBe(bad);
    } finally { await w.cleanup(); }
  });
});
