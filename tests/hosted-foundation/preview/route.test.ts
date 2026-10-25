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
