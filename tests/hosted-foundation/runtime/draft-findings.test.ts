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
