import { afterEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { load } from '../../../deploy/client/routes/operator/cases/[caseId]/preview/[candidateId]/+page.server.ts';
import { createPrivatePreview, setPrivatePreviewComposition } from '../../../src/lib/server/runtime/hosted/private-preview.ts';
import { ids } from '../storage/fixture.ts';
import { CLIENT, caseId, now, previewWorld, type PreviewWorld } from './fixture.ts';

const worlds: PreviewWorld[] = [];
afterEach(() => { setPrivatePreviewComposition(null); for (const p of worlds.splice(0)) p.w.db.sqlite.close(); });

function event(p: PreviewWorld | null, o: { identity?: unknown; caseId?: string; candidateId?: string; search?: string } = {}) {
  const c = o.caseId ?? caseId, cand = o.candidateId ?? p?.candidate.candidateId ?? 'cand-00000000000000000000000000000000';
  const request = new Request(`https://synthetic.invalid/operator/cases/${c}/preview/${cand}${o.search ?? ''}`);
  const headers: Record<string, string> = {};
  const e = { request, url: new URL(request.url), params: { caseId: c, candidateId: cand }, locals: { identity: o.identity ?? p?.operator.identity },
    setHeaders(h: Record<string, string>) { Object.assign(headers, h); } } as unknown as RequestEvent;
  return { e, request, headers };
}
/** Composes the preview for exactly one Request object, as compositions.ts does. */
function compose(p: PreviewWorld, only: Request, who = p.operator) {
  const seen: Request[] = [];
  const authority = p.authorityOf(who);
  const preview = createPrivatePreview({ clientId: ids.clientA, identity: who.identity, db: p.w.db, audit: who.audit, now,
    authorizeOperate: (a) => authority.authorizeOperate({ ...a, capability: 'operate' }), operateCondition: (a) => authority.operate.condition(a) });
  setPrivatePreviewComposition(({ request }) => { seen.push(request); return request === only ? preview : null; });
  return seen;
}
const status = async (work: Promise<unknown>) => { try { await work; return 200; } catch (e) { return (e as { status?: number }).status ?? -1; } };

describe('the private candidate preview page', () => {
  it('answers 503 when this exact request has no composed preview, and resolves only the original Request', async () => {
    const p = await previewWorld(); worlds.push(p);
    const a = event(p), b = event(p);
    const seen = compose(p, a.request);
    expect(await status(load(b.e))).toBe(503);
    expect(seen).toEqual([b.request]);
    expect(b.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses a client principal with 403 and an unverified request with 401, before resolving any preview', async () => {
    const p = await previewWorld(); worlds.push(p);
    p.grant('synthetic-client', 'viewer', 'client');
    const client = p.identityOf({ issuer: CLIENT, subject: 'synthetic-client', kind: 'client' });
    const c = event(p, { identity: client.identity }), seen = compose(p, c.request, client);
    expect(await status(load(c.e))).toBe(403);
    const anon = event(p, { identity: { kind: 'anonymous', principal: null, sessionId: null, clientId: ids.clientA } });
    expect(await status(load(anon.e))).toBe(401);
    expect(seen).toEqual([]);
  });

  it('answers a foreign or stale candidate with 404 and no data', async () => {
    const p = await previewWorld(); worlds.push(p);
    const foreign = event(p, { caseId: p.caseB });
    compose(p, foreign.request);
    expect(await status(load(foreign.e))).toBe(404);
    const unknown = event(p, { candidateId: 'cand-00000000000000000000000000000000' });
    compose(p, unknown.request);
    expect(await status(load(unknown.e))).toBe(404);
  });

  it('shows PRIVATE / NOT PUBLISHED with the exact resultsVersion, chronology, original view/download links and missing bundles', async () => {
    const p = await previewWorld(); worlds.push(p);
    const r = event(p, { search: '?bundle=Original' });
    compose(p, r.request);
    const data = await load(r.e);
    const pin = p.candidate.link.candidate;
    expect(data).toMatchObject({ caseId, candidateId: p.candidate.candidateId, resultsVersion: pin.resultsVersion, published: false });
    expect(data.chronology.total).toBe(2);
    expect(data.chronology.items.map((i) => i.ref)).toEqual(['JN-001']);
    const enc = encodeURIComponent;
    expect(data.chronology.items[0]).toMatchObject({ viewHref: `/cases/${enc(caseId)}/originals/${enc(p.assetId)}/view`, downloadHref: `/cases/${enc(caseId)}/originals/${enc(p.assetId)}?download=1` });
    expect(data.unavailable.map((u) => u.ref)).toEqual(['JN-002', 'P-d951f19ec198c55f']);
    expect(data.originals).toHaveLength(1);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(data)).not.toMatch(/orig\/|pkg\/|\/v\/sha256|chronologyHref/);
  });
});

// The route's own early refusal is a denial too (REVIEW.md, denial without an audit event): asserted through the real
// load, the real request audit sink and the real events table, not through the reader alone.
describe('the private candidate preview page: denial audit', () => {
  const ACTION = 'results.preview-candidate';
  const auditRows = (p: PreviewWorld) => p.w.db.sqlite.prepare('SELECT action, object_kind, object_id, case_id, version, outcome, actor_kind, canonical FROM native_audit_events WHERE action = ? ORDER BY seq').all(ACTION) as
    { action: string; object_kind: string; object_id: string; case_id: string; version: string | null; outcome: string; actor_kind: string; canonical: string }[];
  async function clientRequest(p: PreviewWorld, o: { caseId?: string; candidateId?: string } = {}, granted = false) {
    if (!granted) p.grant('synthetic-client', 'viewer', 'client');
    const client = p.identityOf({ issuer: CLIENT, subject: 'synthetic-client', kind: 'client' });
    const r = event(p, { identity: client.identity, ...o });
    return { client, r };
  }
  const refusal = async (work: Promise<unknown>) => { try { await work; } catch (e) { return e as { status: number; body: { message: string; code: string } }; } throw new Error('the page answered'); };

  it('records one scoped denied event for a client principal, and still answers 403 with no data', async () => {
    const p = await previewWorld(); worlds.push(p);
    const { client, r } = await clientRequest(p);
    compose(p, r.request, client);
    const x = await refusal(load(r.e));
    expect(x.status).toBe(403);
    expect(x.body).toEqual({ message: 'This preview requires explicit operator access.', code: 'forbidden', status: 403 });
    expect(r.headers['cache-control']).toBe('private, no-store');
    const rows = auditRows(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: ACTION, object_kind: 'candidate', object_id: p.candidate.candidateId, case_id: caseId, version: null, outcome: 'denied', actor_kind: 'verified' });
    expect(rows[0]!.canonical).toContain('synthetic-client');
    expect(rows[0]!.canonical).not.toContain(p.candidate.link.candidate.resultsVersion);
  });

  it('adds no event on an admitted staff denial that the reader already records', async () => {
    const p = await previewWorld(); worlds.push(p);
    p.revokeContent();
    const r = event(p);
    compose(p, r.request);
    // the admitted path's own refusal keeps its existing status (refuse() hides a missing content grant as 404)
    expect((await refusal(load(r.e))).status).toBe(404);
    expect(auditRows(p).map((e) => e.outcome)).toEqual(['denied']);
  });

  it('answers 403 when the denial cannot be recorded, and when this request has no composed preview', async () => {
    const p = await previewWorld(); worlds.push(p);
    const { client, r } = await clientRequest(p);
    const authority = p.authorityOf(client);
    const failing = { append: async () => { throw new Error('synthetic audit fault with a secret token'); } };
    const preview = createPrivatePreview({ clientId: ids.clientA, identity: client.identity, db: p.w.db, audit: failing, now,
      authorizeOperate: (a) => authority.authorizeOperate({ ...a, capability: 'operate' }), operateCondition: (a) => authority.operate.condition(a) })!;
    setPrivatePreviewComposition(({ request }) => (request === r.request ? preview : null));
    const x = await refusal(load(r.e));
    expect(x.status).toBe(403);
    expect(JSON.stringify(x.body)).not.toContain('secret');
    const other = event(p, { identity: client.identity });
    setPrivatePreviewComposition(null);
    expect((await refusal(load(other.e))).status).toBe(403);
    expect(auditRows(p)).toEqual([]);
  });

  it('records nothing for an unverified request, and nothing scoped to a traversal or malformed identifier', async () => {
    const p = await previewWorld(); worlds.push(p);
    const anon = event(p, { identity: { kind: 'anonymous', principal: null, sessionId: null, clientId: ids.clientA } });
    compose(p, anon.request);
    expect((await refusal(load(anon.e))).status).toBe(401);
    p.grant('synthetic-client', 'viewer', 'client');
    for (const bad of ['../case', 'a/b', '%2e%2e', 'x'.repeat(200)]) {
      const { client, r } = await clientRequest(p, { candidateId: bad }, true);
      compose(p, r.request, client);
      expect((await refusal(load(r.e))).status).toBe(403);
    }
    expect(auditRows(p)).toEqual([]);
  });
});
