// Native operator submission list, manifest and download: the adverse HTTP contract of the hosted operator routes.
// Synthetic PDFs only; the storage, assets, capability and audit sides are unit doubles (doubles.ts), so a pass here is
// component evidence, not a hosted PASS and not a native-flow acceptance.
import { describe, expect, it } from 'vitest';
import type { CaseId, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { CASE_A, CASE_B, CLIENT, identity, seed, sha, syntheticPdf, world, type World } from './doubles.ts';
import { compose, dispatch, type Route } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const base = (caseId: string, operationId?: string) => `/operator/submissions/${caseId}/finalized${operationId ? `/${operationId}` : ''}`;
const PATHS: Record<Route, (c: string, o: string) => string> = { list: (c) => base(c), view: (c, o) => base(c, o), manifest: (c, o) => `${base(c, o)}/manifest`, download: (c, o) => `${base(c, o)}/download` };
function call(route: Route, caseId: string, operationId: string, o: { who?: Identity; method?: 'GET' | 'HEAD'; headers?: Record<string, string> } = {}) {
  const url = new URL(PATHS[route](caseId, operationId), ORIGIN);
  const request = new Request(url, { method: o.method ?? 'GET', headers: o.headers });
  return dispatch(route, o.method ?? 'GET', { request, url, params: route === 'list' ? { caseId } : { caseId, operationId }, locals: { identity: o.who ?? identity() } });
}
const ROUTES: Route[] = ['list', 'view', 'manifest', 'download'];
const text = async (r: Response) => new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());
function ready(w: World) { compose(w.ports); return w; }
const untouched = (w: World) => { expect(w.repoCalls).toEqual([]); expect(w.assets.calls).toEqual([]); expect(w.audit.events).toEqual([]); };

describe('request-scoped composition', () => {
  it('answers 503 on every route, with no body of case data, until the parent composes real ports', async () => {
    compose(null);
    for (const route of ROUTES) {
      const r = await call(route, CASE_A, 'op-0001-0b7c2f3e1d2a4c5b');
      expect(r.status, route).toBe(503);
      expect(r.headers.get('retry-after')).toBe('2');
      expect(await r.json()).toMatchObject({ code: 'operator-download-unavailable' });
    }
  });
  it.each(['authorizeOperate', 'repository', 'assets', 'audit'])('answers 503 when the %s port is null and reads nothing', async (port) => {
    const w = world(); await seed(w);
    compose({ ...w.ports, [port]: null });
    const [first] = w.repoCalls;
    for (const route of ROUTES) expect((await call(route, CASE_A, 'op-0001-0b7c2f3e1d2a4c5b')).status).toBe(503);
    expect(w.repoCalls.length).toBe(0 + (first ? 1 : 0));
    expect(w.assets.calls).toEqual([]);
  });
});

describe('authority is decided before any row, body or object', () => {
  it('refuses a staff identity that can read the original but holds no operate capability, with the same uniform 404 as an unknown case', async () => {
    const w = ready(world({ operate: [] })); const s = await seed(w);
    const unknown = await call('download', 'case-unknown', s.operationId);
    for (const route of ROUTES) {
      const r = await call(route, CASE_A, s.operationId);
      expect(r.status, route).toBe(404);
      expect(await text(r), route).toBe(await text(await call(route, 'case-unknown', s.operationId)));
    }
    expect(unknown.status).toBe(404);
    untouched(w);
  });
  it('refuses a holder of the operate capability whose identity has no original access', async () => {
    const w = ready(world()); const s = await seed(w);
    for (const route of ROUTES) expect((await call(route, CASE_A, s.operationId, { who: identity({ readOriginal: [CASE_B] }) })).status, route).toBe(404);
    untouched(w);
  });
  it('does not let a capability or access on another case reach this case or its manifest', async () => {
    const w = ready(world({ operate: [CASE_B] })); const a = await seed(w);
    const r = await call('manifest', CASE_A, a.operationId, { who: identity({ readOriginal: [CASE_A, CASE_B] }) });
    expect(r.status).toBe(404);
    untouched(w);
  });
  it('refuses a client-kind principal even when the capability and access both say yes', async () => {
    const w = ready(world()); const s = await seed(w);
    for (const route of ROUTES) expect((await call(route, CASE_A, s.operationId, { who: identity({ principalKind: 'client' }) })).status, route).toBe(404);
    untouched(w);
  });
  it('answers 401 for an anonymous caller, another client and a revoked session, reading nothing', async () => {
    const w = ready(world()); const s = await seed(w);
    expect((await call('download', CASE_A, s.operationId, { who: identity({ kind: 'anonymous' }) })).status).toBe(401);
    const other = await call('view', CASE_A, s.operationId, { who: identity({ clientId: 'client-b' as never }) });
    expect(other.status).toBe(401);
    expect(await other.json()).toMatchObject({ code: 'wrong-client' });
    expect((await call('list', CASE_A, s.operationId, { who: identity({ revoked: true }) })).status).toBe(401);
    untouched(w);
  });
  it('fails closed to 503 when the capability service is down, never to an allow', async () => {
    const w = world(); const s = await seed(w);
    compose({ ...w.ports, authorizeOperate: async () => { throw Object.assign(new Error('x'), { code: 'identity-unavailable' }); } });
    for (const route of ROUTES) expect((await call(route, CASE_A, s.operationId)).status, route).toBe(503);
    untouched(w);
  });
  it('treats a malformed case or submission id as the same uniform not-found, before any port', async () => {
    const w = ready(world());
    const ref = await text(await call('view', 'case-unknown', 'op-0001-0b7c2f3e1d2a4c5b'));
    w.operateCalls.length = 0; // the reference answer above went through the capability check; the malformed ids below must not
    for (const [c, o] of [['../x', 'op-0001-0b7c2f3e1d2a4c5b'], [CASE_A, '..%2f..'], [CASE_A, 'short'], ['', 'op-0001-0b7c2f3e1d2a4c5b']] as const) {
      const r = await call('view', c, o);
      expect(r.status, `${c} ${o}`).toBe(404);
      expect(await text(r)).toBe(ref);
    }
    untouched(w);
    expect(w.operateCalls).toEqual([]);
  });
});

describe('an unknown submission of an authorized case', () => {
  it('gets the very same refusal as a case the operator may not reach', async () => {
    const w = ready(world());
    const r = await call('view', CASE_A, 'op-7777-0b7c2f3e1d2a4c5b');
    expect(r.status).toBe(404);
    expect(await text(r)).toBe(await text(await call('view', 'case-unknown', 'op-7777-0b7c2f3e1d2a4c5b')));
    expect(w.assets.calls).toEqual([]);
    expect(w.audit.events).toEqual([]);
  });
});

describe('only a finalized submission is served', () => {
  it.each(['received', 'stored', 'reserved'] as const)('refuses %s truthfully on view, manifest and download, and releases no manifest or byte', async (stage) => {
    const w = ready(world()); const s = await seed(w, { stage });
    const pdf = new TextDecoder().decode(syntheticPdf(s.operationId));
    for (const route of ['view', 'manifest', 'download'] as const) {
      const r = await call(route, CASE_A, s.operationId);
      expect(r.status, route).toBe(409);
      const body = await text(r);
      expect(JSON.parse(body)).toMatchObject({ code: 'not-finalized', stage: stage === 'received' ? 'received' : 'stored-not-finalized' });
      expect(body).not.toContain(s.sha256);
      expect(body).not.toContain(pdf);
      expect(body).not.toContain('manifest-sha');
    }
    expect(w.assets.calls).toEqual([]);
    expect(w.audit.events.filter((e) => e.action.endsWith('download'))).toEqual([]);
  });
  it('lists finalized submissions only, and counts the pending ones without describing them', async () => {
    const w = ready(world());
    const done = await seed(w), reserved = await seed(w, { stage: 'reserved' }); await seed(w, { stage: 'received' });
    const r = await call('list', CASE_A, '');
    const body = await r.json() as { submissions: { operationId: string }[]; pendingCount: number };
    expect(body.submissions.map((x) => x.operationId)).toEqual([done.operationId]);
    expect(body.pendingCount).toBe(2);
    expect(JSON.stringify(body)).not.toContain(reserved.operationId);
  });
  it('never shows another case\'s submission through this case, and never its metadata', async () => {
    const w = ready(world({ operate: [CASE_A, CASE_B] }));
    const b = await seed(w, { caseId: CASE_B, path: 'secret/Other Case.pdf' });
    for (const route of ['view', 'manifest', 'download'] as const) {
      const r = await call(route, CASE_A, b.operationId, { who: identity({ readOriginal: [CASE_A, CASE_B] }) });
      expect(r.status, route).toBe(404);
      expect(await text(r)).not.toContain('Other Case');
    }
    const l = await (await call('list', CASE_A, '', { who: identity({ readOriginal: [CASE_A, CASE_B] }) })).json();
    expect(JSON.stringify(l)).not.toContain(b.operationId);
    expect(w.assets.calls).toEqual([]);
  });
  it('refuses a manifest whose recorded file no longer matches the stored original, without sending a byte', async () => {
    for (const tamper of [{ sha256: sha('other') }, { size: 3 }, { mediaType: 'text/html' }] as const) {
      const w = ready(world()); const s = await seed(w);
      w.assets.tamper = tamper;
      const r = await call('download', CASE_A, s.operationId);
      expect(r.status, JSON.stringify(tamper)).toBe(410);
      expect(w.assets.calls).toEqual(['metadata']);
      expect(w.audit.events.find((e) => e.outcome === 'succeeded' && e.action.endsWith('download'))).toBeUndefined();
    }
  });
});

describe('what the operator is given', () => {
  it('serves the immutable manifest with its identity, the exact manifest link and the download path, and claims no processing', async () => {
    const w = ready(world()); const s = await seed(w);
    const v = await call('view', CASE_A, s.operationId);
    expect(v.status).toBe(200);
    const raw = await text(v), view = JSON.parse(raw);
    expect(view).toMatchObject({ operationId: s.operationId, caseId: CASE_A, clientId: CLIENT, sequence: 1, revisionId: `subrev-${s.operationId}`, manifestHref: `${base(CASE_A, s.operationId)}/manifest`, downloadHref: `${base(CASE_A, s.operationId)}/download` });
    expect(view.files).toEqual([{ path: 'docs/Claim File.pdf', filename: 'Claim File.pdf', mediaType: 'application/pdf', size: s.bytes.byteLength, sha256: s.sha256, downloadHref: `${base(CASE_A, s.operationId)}/download` }]);
    expect(raw).not.toMatch(/awaiting|processing|queue|claimed|results/i);
    const m = await call('manifest', CASE_A, s.operationId);
    const mb = await bytes(m);
    expect(m.status).toBe(200);
    expect(sha(mb)).toBe(view.manifestSha256);
    expect(m.headers.get('x-clearcase-manifest-sha256')).toBe(view.manifestSha256);
    expect(JSON.parse(new TextDecoder().decode(mb))).toEqual(view.manifest);
    expect(view.manifest).toMatchObject({ format: 'clearcase.submission-manifest/1', clientId: CLIENT, caseId: CASE_A, operationId: s.operationId });
    expect(m.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"/);
    expect(m.headers.get('x-content-type-options')).toBe('nosniff');
    expect(m.headers.get('cache-control')).toContain('no-store');
  });
  it('serves the complete PDF bytes with path, hash, size and case identity, bound to its manifest, as a download-safe attachment', async () => {
    const w = ready(world()); const s = await seed(w, { path: 'a/ü "q" \\ x.pdf'.replace(/[\\"]/g, '') });
    const r = await call('download', CASE_A, s.operationId);
    expect(r.status).toBe(200);
    const got = await bytes(r);
    expect(Array.from(got)).toEqual(Array.from(s.bytes));
    expect(sha(got)).toBe(s.sha256);
    const h = r.headers;
    expect(h.get('content-length')).toBe(String(s.bytes.byteLength));
    expect(h.get('accept-ranges')).toBe('bytes');
    expect(h.get('content-type')).toBe('application/pdf');
    expect(h.get('content-disposition')).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._'-]+$/);
    expect(h.get('content-disposition')).toContain('%C3%BC');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('cache-control')).toContain('no-store');
    expect(h.get('content-security-policy')).toContain('sandbox');
    expect(h.get('x-clearcase-case')).toBe(CASE_A);
    expect(h.get('x-clearcase-submission')).toBe(s.operationId);
    expect(h.get('x-clearcase-sha256')).toBe(s.sha256);
    expect(h.get('x-clearcase-path')).toBeNull(); // the path is provenance in the manifest, never a response header
    expect(h.get('repr-digest')).toBe(`sha-256=:${Buffer.from(s.sha256, 'hex').toString('base64')}:`);
    expect(h.get('link')).toBe(`<${base(CASE_A, s.operationId)}/manifest>; rel="describedby"; type="application/json"`);
  });
  it('cannot be made to inject a header or a path through a hostile recorded file name', async () => {
    const w = ready(world()); const s = await seed(w, { path: 'ok/x.pdf', filename: 'a"; filename*=UTF-8\'\'evil.html\r\nx-injected: 1/../../b.pdf' });
    const r = await call('download', CASE_A, s.operationId);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-injected')).toBeNull();
    const disp = r.headers.get('content-disposition')!;
    expect(disp).not.toMatch(/[\r\n]/);
    expect(disp).not.toContain('evil.html');
    expect(disp).not.toContain('/');
    expect(disp.match(/filename=/g)).toHaveLength(1);
  });
});

describe('bounded, ranged, integrity-checked bytes', () => {
  it('serves one range as 206 with its exact Content-Range and only those bytes', async () => {
    const w = ready(world()); const s = await seed(w, { bytes: syntheticPdf('r', 400) });
    const r = await call('download', CASE_A, s.operationId, { headers: { range: 'bytes=10-59' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 10-59/${s.bytes.byteLength}`);
    expect(r.headers.get('content-length')).toBe('50');
    expect(Array.from(await bytes(r))).toEqual(Array.from(s.bytes.slice(10, 60)));
    expect(r.headers.get('x-clearcase-sha256')).toBe(s.sha256); // the identity of the whole file, not of the slice
  });
  it('passes a suffix range and a 416, and ignores a range it does not understand rather than guess', async () => {
    const w = ready(world()); const s = await seed(w, { bytes: syntheticPdf('r', 400) });
    const suffix = await call('download', CASE_A, s.operationId, { headers: { range: 'bytes=-20' } });
    expect(suffix.status).toBe(206);
    expect((await bytes(suffix)).byteLength).toBe(20);
    const past = await call('download', CASE_A, s.operationId, { headers: { range: `bytes=${s.bytes.byteLength + 5}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${s.bytes.byteLength}`);
    expect((await bytes(past)).byteLength).toBe(0);
    for (const range of ['bytes=0-1,5-9', 'items=0-1', `bytes=0-${'9'.repeat(200)}`, 'bytes=a-b']) {
      const r = await call('download', CASE_A, s.operationId, { headers: { range } });
      expect(r.status, range).toBe(200);
      expect((await bytes(r)).byteLength, range).toBe(s.bytes.byteLength);
    }
    expect(w.assets.requests.some((q) => q.range?.includes(','))).toBe(false);
  });
  it('answers HEAD with the same identity and no body, pulling no byte', async () => {
    const w = ready(world()); const s = await seed(w);
    const r = await call('download', CASE_A, s.operationId, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(s.bytes.byteLength));
    expect(r.headers.get('x-clearcase-sha256')).toBe(s.sha256);
    expect((await bytes(r)).byteLength).toBe(0);
    expect(w.assets.pulled).toBe(0);
    expect(w.assets.requests[0].method).toBe('HEAD');
  });
  it('streams on demand: no body byte is pulled before the response is read', async () => {
    const w = ready(world()); const s = await seed(w, { bytes: syntheticPdf('big', 2000) });
    const r = await call('download', CASE_A, s.operationId);
    expect(w.assets.pulled).toBe(0);
    const reader = r.body!.getReader();
    await reader.read();
    expect(w.assets.pulled).toBeLessThan(s.bytes.byteLength);
    await reader.cancel();
  });
  it('errors the stream rather than deliver more or fewer bytes than the manifest says', async () => {
    for (const tamper of [{ extraBytes: 7 }, { shortBytes: 7 }] as const) {
      const w = ready(world()); const s = await seed(w);
      w.assets.tamper = tamper;
      const r = await call('download', CASE_A, s.operationId);
      expect(r.status).toBe(200);
      await expect(bytes(r), JSON.stringify(tamper)).rejects.toThrow();
    }
  });
  it('refuses a service answer that contradicts the manifest, before any byte is released', async () => {
    for (const tamper of [{ contentRange: 'bytes 0-9/999999' }, { status: 301 }] as const) {
      const w = ready(world()); const s = await seed(w);
      w.assets.tamper = tamper;
      const r = await call('download', CASE_A, s.operationId, { headers: { range: 'bytes=0-9' } });
      expect(r.status, JSON.stringify(tamper)).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'asset-unavailable' });
    }
  });
  it('maps a missing stored original to a truthful 410 after the audit record, not to a 200', async () => {
    const w = ready(world()); const s = await seed(w);
    w.assets.tamper = { missing: true };
    const r = await call('download', CASE_A, s.operationId);
    expect(r.status).toBe(410);
    expect(w.audit.events.some((e) => e.action === 'operator.submission.download' && e.outcome === 'succeeded')).toBe(false);
  });
});

describe('every release is audited first and read-only', () => {
  it('records the download with the verified actor, case and submission before the first byte is requested', async () => {
    const w = ready(world()); const s = await seed(w);
    const order: string[] = []; w.audit.order = order; w.assets.order = order;
    const r = await call('download', CASE_A, s.operationId);
    expect(order).toEqual(['audit', 'get']);
    await bytes(r);
    const recorded = {
      outcome: 'succeeded', at: '2026-10-25T09:00:00.000Z', version: null,
      actor: { kind: 'verified', principal: { issuer: 'https://staff.issuer.test', subject: 'operator-1', kind: 'staff' }, sessionId: expect.any(String) },
      object: { kind: 'submission', id: s.operationId, caseId: CASE_A },
    };
    expect(w.audit.events).toEqual([
      { ...recorded, eventId: 'evt-1', action: 'operator.submission.download.intent' },
      { ...recorded, eventId: 'evt-1:completed', action: 'operator.submission.download' },
    ]);
    expect(w.operateCalls).toHaveLength(2);
    for (const check of w.operateCalls) expect(check).toMatchObject({ caseId: CASE_A, capability: 'operate' });
  });
  it('releases nothing when the audit record cannot be written', async () => {
    for (const route of ['list', 'view', 'manifest', 'download'] as const) {
      const w = ready(world()); const s = await seed(w);
      w.audit.failNext = true;
      const r = await call(route, CASE_A, s.operationId);
      expect(r.status, route).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'audit-unavailable' });
      expect(w.assets.calls.filter((c) => c.startsWith('get')), route).toEqual([]);
    }
  });
  it('audits list, view and manifest reads, each as its own action on the case or the submission', async () => {
    const w = ready(world()); const s = await seed(w);
    for (const route of ROUTES) await call(route, CASE_A, s.operationId);
    expect(w.audit.events.map((e) => [e.action, e.object.kind, e.object.id])).toEqual([
      ['operator.submission.list', 'case', CASE_A], ['operator.submission.read', 'submission', s.operationId],
      ['operator.submission.manifest', 'submission', s.operationId], ['operator.submission.download.intent', 'submission', s.operationId],
    ]);
  });
  it('writes nothing: no intake row changes and the stored upload stays as it was', async () => {
    const w = ready(world()); const s = await seed(w);
    const before = JSON.stringify([w.db.rows('SELECT * FROM submissions_upload'), w.db.rows('SELECT * FROM submissions_revision'), w.db.rows('SELECT * FROM submissions_file')]);
    for (const route of ROUTES) await bytes(await call(route, CASE_A, s.operationId));
    expect(JSON.stringify([w.db.rows('SELECT * FROM submissions_upload'), w.db.rows('SELECT * FROM submissions_revision'), w.db.rows('SELECT * FROM submissions_file')])).toBe(before);
    expect(w.repoCalls.filter((c) => !['list', 'upload', 'revision'].includes(c))).toEqual([]);
  });
});

describe('a recorded submission that contradicts itself is not served', () => {
  it('answers 503 for a finalized upload whose manifest names another case, operation or file', async () => {
    const w = ready(world()); const s = await seed(w);
    const repo = w.ports.repository as { revision: (a: unknown) => Promise<unknown> };
    const real = repo.revision.bind(repo);
    for (const patch of [{ caseId: CASE_B }, { operationId: 'op-9999-0b7c2f3e1d2a4c5b' }, { files: [] }, { clientId: 'client-b' }]) {
      compose({ ...w.ports, repository: { ...w.ports.repository as object, revision: async (a: unknown) => ({ ...(await real(a) as object), ...patch }), list: async () => [] } });
      for (const route of ['view', 'manifest', 'download'] as const) {
        const r = await call(route, CASE_A, s.operationId);
        expect(r.status, `${route} ${JSON.stringify(patch)}`).toBe(503);
        expect(await text(r)).not.toContain(s.sha256);
      }
    }
    expect(w.assets.calls).toEqual([]);
  });
});
