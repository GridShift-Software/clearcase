// Regressions for the 17 October draft review (.orchestration/reports/CODEX-GRS112-DRAFT-20261017/review.md), one
// describe per finding. Finding 1 (glob edges) lives with the guard's own tests in hosted-imports.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBackend } from '../../../src/lib/server/runtime/memory.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { fixture } from './fixture.ts';

let fx: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { fx = await fixture(); });
afterAll(async () => { await fx?.cleanup(); });
const now = () => new Date('2026-10-17T00:00:00Z');
const clientA = () => id('client', 'client-a');

describe('finding 2: exact publication is rechecked after every awaited provider', () => {
  it('a provider that withdraws the case mid-read releases nothing from any provider-backed read', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const viewer = backend.request({ clientId: clientA(), sessionId: id('session', 'a-viewer') });
    const editor = backend.request({ clientId: clientA(), sessionId: id('session', 'a-editor') });
    const scope = { caseId: fx.caseId, resultsVersion: fx.rv }, publish = () => backend.publish({ clientId: clientA(), caseId: fx.caseId, publication: { kind: 'published', resultsVersion: fx.rv } });
    let withdraw = false;
    const provider = { id: 'withdrawer', owner: 'test', revision: async () => 'r1', rows: async () => {
      if (withdraw) backend.publish({ clientId: clientA(), caseId: fx.caseId, publication: { kind: 'withdrawn' } });
      return [];
    } };
    viewer.store.providers.register(provider); editor.store.providers.register(provider);
    expect((await viewer.store.documentRows(scope)).rows.length).toBeGreaterThan(0);
    withdraw = true;
    const reads = [
      () => viewer.store.documentRows(scope), () => viewer.store.listJson(scope), () => viewer.store.fingerprints(scope),
      () => viewer.store.documentRow({ ...scope, ref: 'HOSTED-001' }), () => viewer.store.documentCounts(scope),
      () => viewer.store.existingRefs({ ...scope, refs: ['HOSTED-001'] }), () => viewer.store.childDocuments({ ...scope, ref: 'HOSTED-001' }),
      () => viewer.store.anyDateBasis(scope), () => viewer.store.activeDocumentRows({ caseId: fx.caseId }),
      () => editor.userWork.anchorFor({ ...scope, ref: 'HOSTED-001' }),
    ];
    for (const read of reads) { publish(); await expect(read()).rejects.toMatchObject({ code: 'forbidden' }); }
  });
});

describe('finding 3: request handles capture immutable client and session values', () => {
  it('replacing the caller-owned input after construction does not revive a revoked session', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const input = { clientId: clientA(), sessionId: id('session', 'a-viewer') };
    const viewer = backend.request(input);
    backend.revoke(id('session', 'a-viewer'));
    input.sessionId = id('session', 'a-editor');
    await expect(viewer.store.getCase({ caseId: fx.caseId })).rejects.toMatchObject({ code: 'invalid-session' });
  });
  it('a write acts on the scope it was called with, not on a scope the caller mutates while it is in flight', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const editor = backend.request({ clientId: clientA(), sessionId: id('session', 'a-editor') });
    const call = { caseId: fx.caseId, store: 'deadlines', rowId: null, fields: { title: 'kept' }, anchor: null, expected: { kind: 'absent' as const }, operationId: 'op-scope' };
    const pending = editor.userWork.putRow(call);
    call.caseId = fx.pending; call.fields.title = 'swapped';
    expect((await pending).kind).toBe('written');
    expect((await editor.userWork.listRows({ caseId: fx.caseId, store: 'deadlines' })).map((r) => r.fields.title)).toEqual(['kept']);
    expect(await editor.userWork.listRows({ caseId: fx.pending, store: 'deadlines' })).toEqual([]);
  });
});

describe('finding 4: protected reads persist their audit event before release, and denials append one', () => {
  const asset = () => ({ kind: 'original' as const, caseId: fx.caseId, assetId: 'HOSTED-001' });
  const get = { method: 'GET' as const, range: null, ifRange: null };
  it('an authorized original is withheld (503, no bytes) when audit persistence fails', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const viewer = backend.request({ clientId: clientA(), sessionId: id('session', 'a-viewer') });
    backend.fail('audit');
    const response = await viewer.assets.get({ asset: asset(), request: get });
    expect(response.status).toBe(503);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
  it('a delivered original appends a succeeded event first, and a denied one appends a scoped denial', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const viewer = backend.request({ clientId: clientA(), sessionId: id('session', 'a-viewer') });
    const unassigned = backend.request({ clientId: clientA(), sessionId: id('session', 'a-unassigned') });
    expect((await viewer.assets.get({ asset: asset(), request: get })).status).toBe(200);
    await expect(unassigned.assets.get({ asset: asset(), request: get })).rejects.toMatchObject({ code: 'forbidden' });
    const events = backend.events(clientA()).map((e) => [e.action, e.outcome, e.object.kind, e.object.caseId, e.actor.kind === 'verified' ? e.actor.principal.subject : null]);
    expect(events).toEqual([['asset.read-original', 'succeeded', 'asset', fx.caseId, 'viewer'], ['asset.read-original', 'denied', 'asset', fx.caseId, 'unassigned']]);
  });
  it('a denied case read appends a scoped denial without case text', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const unassigned = backend.request({ clientId: clientA(), sessionId: id('session', 'a-unassigned') });
    await expect(unassigned.store.getCase({ caseId: fx.caseId })).rejects.toMatchObject({ code: 'forbidden' });
    const [event] = backend.events(clientA());
    expect(event).toMatchObject({ action: 'case.read', outcome: 'denied', version: null });
    expect(event!.object).toEqual({ kind: 'case', id: fx.caseId, caseId: fx.caseId });
  });
});

describe('finding 5: the hosted hooks refuse protected requests until their services are ready', () => {
  it('a GET to a selected route is answered 503 without resolving when the request services are unavailable', async () => {
    const { handle } = await import('../../../src/lib/server/runtime/hosted/hooks.server.ts');
    let resolved = 0;
    const url = new URL('https://hosted.example.invalid/cases');
    const event = { request: new Request(url), url, locals: {}, isSubRequest: false } as unknown as Parameters<typeof handle>[0]['event'];
    const response = await handle({ event, resolve: async () => { resolved++; return new Response('protected', { status: 200 }); } });
    expect([response.status, resolved]).toEqual([503, 0]);
    expect(await response.text()).not.toContain('protected');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('finding 6: memberships and case grants are current state, apart from sessions', () => {
  it('withdrawing a grant, a role or a membership binds a live session on its next protected call', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const viewer = backend.request({ clientId: clientA(), sessionId: id('session', 'a-viewer') });
    const editor = backend.request({ clientId: clientA(), sessionId: id('session', 'a-editor') });
    expect((await viewer.store.getCase({ caseId: fx.caseId }))?.caseId).toBe(fx.caseId);
    backend.grant({ clientId: clientA(), subject: 'viewer', caseId: fx.caseId, role: null });
    await expect(viewer.store.getCase({ caseId: fx.caseId })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await viewer.store.listCases()).map((c) => c.caseId)).toEqual([fx.pending]);
    backend.grant({ clientId: clientA(), subject: 'editor', caseId: fx.pending, role: 'viewer' });
    const note = { caseId: fx.pending, target: { kind: 'case' as const }, body: 'case note', expected: { kind: 'absent' as const }, operationId: 'op-grant' };
    await expect(editor.userWork.addNote(note)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await editor.userWork.notesFor({ caseId: fx.pending, target: null })).toEqual([]);
    backend.membership({ clientId: clientA(), subject: 'viewer', member: false });
    await expect(viewer.store.listCases()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(viewer.store.getCase({ caseId: fx.pending })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
