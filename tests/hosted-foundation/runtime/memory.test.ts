import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBackend } from '../../../src/lib/server/runtime/memory.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { RequestServices, Written } from '../../../src/lib/server/runtime/contracts.ts';
import { fixture } from './fixture.ts';
let fx: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { fx = await fixture(); });
afterAll(async () => { await fx?.cleanup(); });
const now = () => new Date('2026-10-17T00:00:00Z');
function written<T>(r: Written<T>) { expect(r.kind).toBe('written'); if (r.kind !== 'written') throw new Error(r.kind); return r; }
const definition = { name: 'costs', owner: 'costs-owner', description: 'Synthetic costs', scope: 'case' as const, columns: [{ name: 'case_id', type: 'TEXT' as const, notNull: true }, { name: 'id', type: 'TEXT' as const }, { name: 'amount', type: 'REAL' as const }], primaryKey: ['case_id', 'id'] };

// The same contract suite runs for both isolated client bindings, with fresh backends per test.
for (const [client, session] of [['client-a', 'a-editor'], ['client-b', 'b-editor']] as const) describe(`memory contract: ${client}`, () => {
  function setup() {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const request = () => backend.request({ clientId: id('client', client), sessionId: id('session', session) });
    return { backend, a: request(), request };
  }
  it('reads immutable package bytes, datasets, document projections and stable pending cases asynchronously', async () => {
    const { a } = setup(), scope = { caseId: fx.caseId, resultsVersion: fx.rv };
    expect(a.store.listCases()).toBeInstanceOf(Promise);
    expect((await a.store.listCases()).map((c) => c.caseId)).toEqual([fx.caseId, fx.pending]);
    expect((await a.store.getCase({ caseId: fx.pending }))?.documents).toBeNull();
    expect(await a.store.activeVersionId({ caseId: fx.pending })).toBeNull();
    expect((await a.store.getVersion({ resultsVersion: fx.rv }))?.case_id).toBe(fx.caseId);
    expect(await a.store.verifyVersion(scope)).toMatchObject({ ok: true });
    expect((await a.store.versionsOf(scope)).length).toBe(1);
    expect(await a.store.previousVersion(scope)).toBeNull();
    expect(await a.store.trustedFor(scope)).toEqual(new Set());
    expect(await a.store.packageFilePaths(scope)).toContain('manifest.json');
    const bytes = await a.store.packageFile({ ...scope, path: 'manifest.json' });
    bytes!.fill(0);
    expect((await a.store.packageFile({ ...scope, path: 'manifest.json' }))![0]).not.toBe(0);
    expect(await a.store.packageFile({ ...scope, path: 'absent' })).toBeNull();
    expect(await a.store.datasetKeys(scope)).toContain('view-content');
    expect(await a.store.datasetOf({ ...scope, key: 'absent' })).toBeNull();
    expect((await a.store.viewContentOf(scope)).views().length).toBeGreaterThan(0);
    const docs = await a.store.documentRows(scope);
    expect(docs.rows.find((d) => d.ref === 'HOSTED-001')).toBeDefined();
    expect((await a.store.documentRow({ ...scope, ref: 'HOSTED-001' }))?.state.mediaType).toBe('application/pdf');
    expect((await a.store.documentCounts(scope)).total).toBe(docs.rows.length);
    expect(await a.store.existingRefs({ ...scope, refs: ['HOSTED-001', 'absent'] })).toEqual(new Set(['HOSTED-001']));
    expect(await a.store.childDocuments({ ...scope, ref: 'HOSTED-001' })).toEqual([]);
    expect((await a.store.fingerprints(scope)).length).toBeGreaterThan(0);
    expect(typeof await a.store.anyDateBasis(scope)).toBe('boolean');
    expect(JSON.parse((await a.store.listJson(scope))!.json).length).toBe(docs.rows.length);
    expect((await a.store.activeDocumentRows(scope)).resultsVersion).toBe(fx.rv);
    expect((await a.store.activeDocumentRows({ caseId: fx.pending })).rows).toEqual([]);
    expect((await a.store.seeds(scope)).length).toBeGreaterThan(0);
    await expect(a.store.datasetKeys({ ...scope, caseId: fx.pending })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('preserves imported precedence and isolates failing providers and their ETags', async () => {
    const { a, request } = setup(), scope = { caseId: fx.caseId, resultsVersion: fx.rv };
    const before = await a.store.listJson(scope), original = (await a.store.documentRows(scope)).rows[0]!;
    const off = a.store.providers.register({ id: 'extra', owner: 'test', revision: async () => 'r1', rows: async () => [{ ...original }] });
    expect((await a.store.documentRows(scope)).dropped.length).toBe(1);
    expect((await a.store.listJson(scope))!.etag).not.toBe(before!.etag);
    expect(request().store.providers.list()).toEqual([]);
    off();
    a.store.providers.register({ id: 'broken', owner: 'test', revision: async () => { throw new Error('private backend text'); }, rows: async () => [] });
    expect((await a.store.documentRows(scope)).failed).toEqual([{ source: 'provider:broken', owner: 'test', reason: 'provider-unavailable' }]);
  });
  it('drops malformed provider projections before they can reach callers', async () => {
    const { a } = setup(), scope = { caseId: fx.caseId, resultsVersion: fx.rv };
    const original = (await a.store.documentRows(scope)).rows[0]!;
    const malformed = { ...original, ref: 'BAD', list: { ...original.list, ref: 'BAD' } };
    Reflect.deleteProperty(malformed.list, 'filename');
    a.store.providers.register({ id: 'malformed', owner: 'test', revision: async () => 'r1', rows: async () => [malformed] });
    const result = await a.store.documentRows(scope);
    expect(result.rows.some((r) => r.ref === 'BAD')).toBe(false);
    expect(result.dropped).toEqual([{ source: 'provider:malformed', ref: 'BAD', reason: 'malformed row: list is not a chronology list entry' }]);
  });
  it('integrity checks every GET/HEAD and explicitly refuses ranges', async () => {
    const { a, backend } = setup(), asset = { kind: 'original' as const, caseId: fx.caseId, assetId: 'HOSTED-001' };
    expect((await a.assets.availability({ asset })).kind).toBe('available');
    expect((await a.assets.metadata({ asset })).size).toBe(fx.bytes.length);
    expect((await a.assets.links({ asset })).downloadHref).toContain(encodeURIComponent(asset.assetId));
    const get = (method: 'GET' | 'HEAD' = 'GET', range: string | null = null, ifRange: string | null = null) => a.assets.get({ asset, request: { method, range, ifRange } });
    expect(new Uint8Array(await (await get()).arrayBuffer())).toEqual(fx.bytes);
    expect((await get()).headers.get('cache-control')).toBe('no-store');
    expect((await get('HEAD')).body).toBeNull();
    expect((await get('GET', 'bytes=0-1')).status).toBe(416);
    expect((await get('GET', 'bytes=0-1', '"old"')).status).toBe(200);
    backend.assetFault({ clientId: a.identity.clientId, asset, kind: 'changed' });
    expect((await get()).status).toBe(410);
    expect((await get('HEAD')).body).toBeNull();
  });
  it('uses row CAS and operation replay across requests; independent work needs no publication', async () => {
    const { a, request } = setup(), caseId = fx.pending;
    const register = a.userWork.registers.open({ caseId, store: 'time' });
    const added = written(await register.add({ fields: { title: 'one' }, operationId: 'add-1' }));
    expect(written(await request().userWork.registers.open({ caseId, store: 'time' }).add({ fields: { title: 'one' }, operationId: 'add-1' })).value.rowId).toBe(added.value.rowId);
    const row = (await register.rows())[0]!;
    const races = await Promise.all([register.replace({ rowId: row.rowId, expected: row.version, fields: { title: 'two' }, operationId: 'edit-1' }), request().userWork.registers.open({ caseId, store: 'time' }).replace({ rowId: row.rowId, expected: row.version, fields: { title: 'three' }, operationId: 'edit-2' })]);
    expect(races.map((r) => r.kind).sort()).toEqual(['stale', 'written']);
    const latest = (await register.rows())[0]!;
    written(await register.remove({ rowId: latest.rowId, expected: latest.version, operationId: 'delete' }));
    expect(await register.remove({ rowId: latest.rowId, expected: latest.version, operationId: 'delete-again' })).toEqual({ kind: 'gone' });
    const note = written(await a.userWork.addNote({ caseId, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'case' }, body: 'a\r\nb' }));
    expect(note.value.body).toBe('a\nb');
    expect((await a.userWork.summary({ caseId, resultsVersion: null })).total).toBe(1);
    expect((await a.userWork.notesFor({ caseId, target: null })).length).toBe(1);
    written(await a.userWork.deleteNote({ caseId, expected: { kind: 'match', version: note.version }, operationId: 'delete-note', id: note.value.id }));
  });
  it('runs atomic register commands and seed/table CAS without bypassing stale tokens', async () => {
    const { a } = setup(), caseId = fx.caseId;
    const register = a.userWork.registers.open({ caseId, store: 'time' });
    written(await register.apply({ commands: [{ kind: 'add', fields: { hours: 1 } }, { kind: 'add', fields: { hours: 2 } }], expectedRevision: await a.store.stateRevision({ caseId }), operationId: 'bulk' }));
    const rows = await register.rows();
    expect(rows.map((r) => r.fields.hours)).toEqual([1, 2]);
    expect(await register.apply({ commands: [{ kind: 'remove', rowId: rows[0]!.rowId }, { kind: 'replace', rowId: 'absent', fields: {} }], expectedRevision: await a.store.stateRevision({ caseId }), operationId: 'failed-bulk' })).toEqual({ kind: 'gone' });
    expect((await register.rows()).length).toBe(2);
    await a.userWork.defineTable({ definition });
    const row = { case_id: caseId, id: 'one', amount: 3 };
    const first = written(await a.userWork.putTableRow({ caseId, table: 'costs', owner: definition.owner, row, expected: { kind: 'absent' }, operationId: 'table-add' }));
    await expect(a.userWork.putTableRow({ caseId, table: 'costs', owner: 'other-owner', row, expected: { kind: 'match', version: first.version }, operationId: 'owner' })).rejects.toMatchObject({ code: 'table-conflict' });
    written(await a.userWork.deleteTableRow({ caseId, table: 'costs', owner: definition.owner, key: { case_id: caseId, id: 'one' }, expected: { kind: 'match', version: first.version }, operationId: 'table-delete' }));
    expect(await a.userWork.listTableRows({ caseId, table: 'costs' })).toEqual([]);
    const seed = (await a.userWork.seedRows({ caseId, resultsVersion: fx.rv }))[0]!;
    const facade = a.userWork.registers.seeds({ caseId, resultsVersion: fx.rv, datasetKey: seed.datasetKey });
    const view = (await facade.views()).find((v) => 'seed' in v && v.seed.seedId === seed.seedId)!;
    const removed = await facade.remove({ seedId: seed.seedId, expected: view.version, operationId: 'seed-delete' });
    if (removed === 'absent') throw new Error('Seed unexpectedly absent');
    written(removed);
    expect(await facade.remove({ seedId: seed.seedId, expected: view.version, operationId: 'seed-delete' })).toEqual(removed);
    expect(await facade.remove({ seedId: seed.seedId, expected: view.version, operationId: 'seed-stale' })).toEqual({ kind: 'stale' });
    expect(await facade.remove({ seedId: 'absent', expected: view.version, operationId: 'absent-seed' })).toBe('absent');
  });
  it('restores defined tables into a fresh backend and invalidates tokens from before restore', async () => {
    const { a } = setup(), caseId = fx.pending;
    await a.userWork.defineTable({ definition });
    written(await a.userWork.putTableRow({ caseId, table: 'costs', owner: definition.owner, row: { case_id: caseId, id: 'one', amount: 7 }, expected: { kind: 'absent' }, operationId: 'table-add' }));
    const saved = await a.userWork.exportAll({ caseId });
    const fresh = createMemoryBackend({ fixture: fx.data, now }).request({ clientId: a.identity.clientId, sessionId: id('session', session) });
    const current = await fresh.userWork.exportAll({ caseId }), expectedRevision = await fresh.store.stateRevision({ caseId });
    const preRestore = await fresh.userWork.snapshots.put({ caseId, snapshot: current, revision: expectedRevision });
    written(await fresh.userWork.importAll({ caseId, snapshot: saved, expectedRevision, preRestore, operationId: 'restore' }));
    expect(await fresh.userWork.exportAll({ caseId })).toEqual(saved);
    const oldVersion = (await a.userWork.listTableRows({ caseId, table: 'costs' }))[0]!.version;
    const freshVersion = (await fresh.userWork.listTableRows({ caseId, table: 'costs' }))[0]!.version;
    expect(freshVersion).not.toBe(oldVersion);
  });
  it('enumerates and restores all work categories atomically with a matching recovery receipt', async () => {
    const { a, request, backend } = setup(), caseId = fx.caseId, scope = { caseId, resultsVersion: fx.rv };
    const anchor = await a.userWork.anchorFor({ ...scope, ref: 'HOSTED-001' });
    expect(await a.userWork.resolve({ anchor, into: scope })).toEqual({ status: 'here', refs: ['HOSTED-001'] });
    written(await a.userWork.addNote({ caseId, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'document', anchor }, body: 'Original note' }));
    const seeds = await a.userWork.seedRows(scope), seed = seeds[0]!;
    written(await a.userWork.putSeedOverlay({ caseId, expected: { kind: 'absent' }, operationId: 'overlay', overlay: { caseId, datasetKey: seed.datasetKey, seedId: seed.seedId, baseSeedSha256: seed.seedSha256, fields: { title: 'changed' } } }));
    expect((await a.userWork.overlays(scope)).length).toBe(1);
    expect((await a.userWork.seedViews(scope)).find((v) => 'overlay' in v)?.state).toBe('edited');
    await a.userWork.defineTable({ definition });
    written(await a.userWork.putTableRows({ caseId, expectedRevision: await a.store.stateRevision({ caseId }), operationId: 'costs', table: definition.name, owner: definition.owner, rows: [{ case_id: caseId, id: 'one', amount: 100 }] }));
    const row = written(await a.userWork.putRow({ caseId, expected: { kind: 'absent' }, operationId: 'register', store: 'selections', rowId: null, anchor: null, fields: { selected: true } }));
    expect(await a.userWork.registerStores({ caseId })).toEqual(['selections']);
    expect((await a.userWork.listRows({ caseId, store: 'selections' }))[0]!.rowId).toBe(row.value.rowId);
    const saved = await a.userWork.exportAll({ caseId });
    expect(saved.tables.map((t) => t.name).sort()).toEqual(['costs', 'note', 'register_row', 'seed_overlay']);
    expect((await a.userWork.tables()).map((t) => t.name)).toContain('costs');
    const revision = await a.store.stateRevision({ caseId });
    const receipt = await a.userWork.snapshots.put({ caseId, snapshot: saved, revision });
    expect(await a.userWork.snapshots.get({ caseId, id: receipt })).toEqual(saved);
    backend.fail('snapshot');
    await expect(a.userWork.snapshots.put({ caseId, snapshot: saved, revision })).rejects.toMatchObject({ code: 'snapshot-failed' });
    backend.fail(null);
    const edit = a.userWork.registers.open({ caseId, store: 'time' });
    written(await edit.add({ fields: { hours: 1 }, operationId: 'intervening' }));
    expect(await a.userWork.importAll({ caseId, expectedRevision: revision, operationId: 'stale-restore', snapshot: saved, preRestore: receipt })).toEqual({ kind: 'stale' });
    const current = await a.userWork.exportAll({ caseId }), fresh = await a.store.stateRevision({ caseId });
    const preRestore = await a.userWork.snapshots.put({ caseId, snapshot: current, revision: fresh });
    backend.fail('audit');
    await expect(a.userWork.importAll({ caseId, expectedRevision: fresh, operationId: 'restore', snapshot: saved, preRestore })).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect(await request().userWork.exportAll({ caseId })).toEqual(current);
    backend.fail(null);
    written(await a.userWork.importAll({ caseId, expectedRevision: fresh, operationId: 'restore', snapshot: saved, preRestore }));
    expect(await a.userWork.exportAll({ caseId })).toEqual(saved);
    expect((await a.userWork.listTableRows({ caseId, table: 'costs' }))[0]!.cells.amount).toBe(100);
    expect((await a.userWork.registers.open({ caseId, store: 'time' }).rows())).toEqual([]);
  });
});

describe('memory authorization and controls', () => {
  it('acknowledges work when the injected clock advances between reads', async () => {
    let tick = Date.parse('2026-10-17T00:00:00Z');
    const backend = createMemoryBackend({ fixture: fx.data, now: () => new Date(tick++) });
    const a = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-editor') });
    written(await a.userWork.addNote({ caseId: fx.pending, expected: { kind: 'absent' }, operationId: 'clock-note', target: { kind: 'case' }, body: 'Advancing clock' }));
    expect(backend.events(a.identity.clientId)).toHaveLength(1);
  });
  it('binds a snapshot receipt to content and revision rather than its export time', async () => {
    let tick = Date.parse('2026-10-17T00:00:00Z');
    const backend = createMemoryBackend({ fixture: fx.data, now: () => new Date(tick) });
    const a = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-editor') });
    const snapshot = await a.userWork.exportAll({ caseId: fx.pending }), revision = await a.store.stateRevision({ caseId: fx.pending });
    tick += 1000;
    const receipt = await a.userWork.snapshots.put({ caseId: fx.pending, snapshot, revision });
    expect(await a.userWork.snapshots.get({ caseId: fx.pending, id: receipt })).toEqual(snapshot);
  });
  it('denies missing, wrong-client, revoked and unassigned/admin/staff identities on protected reads and bytes', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    for (const [session, code] of [[null, 'unauthenticated'], ['b-editor', 'wrong-client'], ['a-unassigned', 'forbidden'], ['a-admin', 'forbidden'], ['a-staff', 'forbidden']] as const) {
      const a = backend.request({ clientId: id('client', 'client-a'), sessionId: session === null ? null : id('session', session) });
      await expect(a.store.getCase({ caseId: fx.caseId })).rejects.toMatchObject({ code });
      await expect(a.assets.metadata({ asset: { kind: 'original', caseId: fx.caseId, assetId: 'HOSTED-001' } })).rejects.toMatchObject({ code });
    }
    const a = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-viewer') });
    await expect(a.userWork.registers.open({ caseId: fx.caseId, store: 'time' }).add({ fields: {}, operationId: 'no' })).rejects.toMatchObject({ code: 'forbidden' });
    backend.revoke(id('session', 'a-viewer'));
    await expect(a.store.listCases()).rejects.toMatchObject({ code: 'invalid-session' });
  });
  it('isolates client work and fresh backends; withdraws previews while originals remain accessible', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const a = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-editor') });
    const b = backend.request({ clientId: id('client', 'client-b'), sessionId: id('session', 'b-editor') });
    written(await a.userWork.addNote({ caseId: fx.pending, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'case' }, body: 'A only' }));
    expect(await b.userWork.notesFor({ caseId: fx.pending, target: null })).toEqual([]);
    const other = createMemoryBackend({ fixture: fx.data, now }).request({ clientId: a.identity.clientId, sessionId: id('session', 'a-editor') });
    expect(await other.userWork.notesFor({ caseId: fx.pending, target: null })).toEqual([]);
    backend.publish({ clientId: a.identity.clientId, caseId: fx.caseId, publication: { kind: 'withdrawn' } });
    await expect(a.store.getVersion({ resultsVersion: fx.rv })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(a.assets.metadata({ asset: { kind: 'preview', caseId: fx.caseId, resultsVersion: fx.rv, assetId: 'private' } })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await a.assets.metadata({ asset: { kind: 'original', caseId: fx.caseId, assetId: 'HOSTED-001' } })).size).toBeGreaterThan(0);
    expect(a.runtime.gate).not.toBeNull();
    await expect(a.runtime.probe()).rejects.toMatchObject({ code: 'missing-binding' });
  });
});

describe('memory metadata names the read it prefaces', () => {
  const private_ = { kind: 'preview' as const, caseId: undefined as never, resultsVersion: undefined as never, assetId: 'private' };
  function withdrawn() {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const a = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-editor') });
    backend.publish({ clientId: a.identity.clientId, caseId: fx.caseId, publication: { kind: 'withdrawn' } });
    const asset = { ...private_, caseId: fx.caseId, resultsVersion: fx.rv };
    const seen = () => backend.events(a.identity.clientId).map((e) => `${e.action} ${e.outcome}`);
    return { a, asset, seen };
  }
  it('audits a refused preview preflight once as asset.read-preview, and a plain call as asset.describe', async () => {
    const { a, asset, seen } = withdrawn();
    await expect(a.assets.metadata({ asset, for: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(seen()).toEqual(['asset.read-preview denied']);
    await expect(a.assets.metadata({ asset })).rejects.toMatchObject({ code: 'forbidden' });
    expect(seen()).toEqual(['asset.read-preview denied', 'asset.describe denied']);
  });
  it('audits a refused original preflight as asset.read-original and records nothing for a granted one', async () => {
    const backend = createMemoryBackend({ fixture: fx.data, now });
    const b = backend.request({ clientId: id('client', 'client-a'), sessionId: id('session', 'a-editor') });
    const original = { kind: 'original' as const, caseId: fx.caseId, assetId: 'HOSTED-001' };
    expect((await b.assets.metadata({ asset: original, for: 'read' })).size).toBeGreaterThan(0);
    expect(backend.events(b.identity.clientId)).toEqual([]);
    backend.revoke(id('session', 'a-editor'));
    await expect(b.assets.metadata({ asset: original, for: 'read' })).rejects.toMatchObject({ code: 'invalid-session' });
    expect(backend.events(b.identity.clientId).map((e) => `${e.action} ${e.outcome}`)).toEqual(['asset.read-original denied']);
  });
});
