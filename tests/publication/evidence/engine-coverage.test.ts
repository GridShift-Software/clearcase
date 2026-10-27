// Fix round 1 for U3: an expired lease authorizes nothing (M1), and a sealed root provably covers exactly the stored item rows (M2).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createEvidenceEngine, d1EvidenceStore, pageBytes, rootBytes, verifyEvidence, type EvidenceStore } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { BOUNDS, TOTAL, binding, d1, database, finish, producer, setup } from './harness.ts';

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const count = (db: ReturnType<typeof setup>['db'], table = 'pub_evidence_item') => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const runRow = (db: ReturnType<typeof setup>['db']) => db.prepare('SELECT state, evidence_root, lease_token, lease_until_ms, cursor FROM pub_evidence_run').get() as
  { state: string; evidence_root: string | null; lease_token: string | null; lease_until_ms: number | null; cursor: string | null };
const append = (db: ReturnType<typeof setup>['db'], key: string) => db.prepare(`INSERT INTO pub_evidence_item (candidate_id, generation, item_key, item_json) VALUES (?, ?, ?, '{}')`).run(binding.candidateId, binding.generation, key);

describe('an expired lease authorizes no write (M1)', () => {
  it('commit refuses when the lease expired mid-step with no takeover, and writes nothing', async () => {
    const run = setup();
    const slow = producer();
    let late = false;
    const engine = run.engine('holder', { producer: async cursor => { if (cursor === '5' && !late) { late = true; run.advance(101); } return slow(cursor); } });
    expect((await engine.step()).kind).toBe('leased');
    expect(count(run.db)).toBe(0);
    expect(runRow(run.db)).toMatchObject({ lease_token: 'holder', lease_until_ms: 100, cursor: null });
  });
  it('the deadline itself is expired: a commit at exactly lease_until_ms is refused, one millisecond earlier is accepted', async () => {
    for (const [advance, kind, rows] of [[100, 'leased', 0], [99, 'progress', 20]] as const) {
      const run = setup();
      const slow = producer();
      let moved = false;
      const engine = run.engine('holder', { producer: async cursor => { if (cursor === '5' && !moved) { moved = true; run.advance(advance); } return slow(cursor); } });
      expect((await engine.step()).kind).toBe(kind);
      expect(count(run.db)).toBe(rows);
    }
  });
  it('the same builder resumes from the stored cursor after its expired step', async () => {
    const run = setup();
    const slow = producer();
    let late = false;
    const engine = run.engine('holder', { producer: async cursor => { if (cursor === '5' && !late) { late = true; run.advance(150); } return slow(cursor); } });
    expect((await engine.step()).kind).toBe('leased');
    expect(await finish(engine)).toBe(await (async () => { const base = setup(); return finish(base.engine('baseline')); })());
    expect(count(run.db)).toBe(TOTAL);
  });
  it('finish refuses when the lease expired between the page read and the seal, and completes nothing', async () => {
    const run = setup(), total = 40;
    const lapsing: EvidenceStore = { ...run.store, pages: async b => { const pages = await run.store.pages(b); run.advance(101); return pages; } };
    const engine = createEvidenceEngine({ binding, store: lapsing, producer: producer(false, total), clock: run.now, leaseId: 'holder', leaseMs: 100, bounds: BOUNDS });
    expect((await engine.step()).kind).toBe('progress');
    expect((await engine.step()).kind).toBe('progress');
    expect((await engine.step()).kind).toBe('leased');
    expect(runRow(run.db)).toMatchObject({ state: 'building', evidence_root: null });
    expect(count(run.db, 'pub_evidence_page')).toBe(0);
    expect(await finish(engine)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the store itself refuses commit and finish from an expired holder, and from a caller that gives no time', async () => {
    const run = setup(), engine = run.engine('holder');
    await engine.step();
    const { cursor } = runRow(run.db);
    const item = [{ key: 'zzzz', json: '{}' }];
    run.advance(100);
    expect(await run.store.commit(binding, 'holder', { cursor }, { items: item, page: null, nextCursor: 'x', leaseUntilMs: 300, nowMs: run.now() })).toBe(false);
    expect(await run.store.commit(binding, 'holder', { cursor }, { items: item, page: null, nextCursor: 'x', leaseUntilMs: 300 })).toBe(false);
    expect(await run.store.finish(binding, 'holder', { cursor }, { page: null, root: 'r'.repeat(64), nextCursor: 'x', digests: [], items: 20, lastKey: '000019', nowMs: run.now() })).not.toBe('sealed');
    expect(count(run.db)).toBe(20);
    expect(runRow(run.db)).toMatchObject({ state: 'building', evidence_root: null, cursor });
  });
});

describe('a sealed root covers exactly the stored items (M2)', () => {
  const small = (total: number) => setup({ producer: producer(false, total) });
  for (const [label, key] of [['after the last key', 'zzzz'], ['before the last key', '0']] as const) {
    it(`a row appended outside the engine ${label}, before finish, stops the build from completing`, async () => {
      const run = small(1), engine = run.engine('a');
      expect((await engine.step()).kind).toBe('progress');
      append(run.db, key);
      expect(await engine.step()).toEqual({ kind: 'refused', reason: 'coverage' });
      expect(runRow(run.db)).toMatchObject({ state: 'building', evidence_root: null });
      expect(count(run.db, 'pub_evidence_page')).toBe(0);
    });
  }
  it('the refused finish seals no page either: the page insert and the completion stand or fall together', async () => {
    const run = small(7), engine = run.engine('a');
    await engine.step();
    append(run.db, 'zzzz');
    expect((await engine.step()).kind).toBe('refused');
    expect(count(run.db, 'pub_evidence_page')).toBe(0);
    expect((await engine.step()).kind).toBe('refused');
  });
  it('a page row appended outside the engine stops a build that ended on a full page', async () => {
    const run = setup(), engine = run.engine('a');
    let result = await engine.step();
    while (count(run.db, 'pub_evidence_page') < 6) result = await engine.step();
    expect(result.kind).toBe('progress');
    run.db.prepare(`INSERT INTO pub_evidence_page (candidate_id, generation, page_number, page_sha256, item_count) VALUES (?, ?, 6, ?, 1)`).run(binding.candidateId, binding.generation, 'f'.repeat(64));
    do result = await engine.step(); while (result.kind === 'progress');
    expect(result).toEqual({ kind: 'refused', reason: 'coverage' });
    expect(runRow(run.db)).toMatchObject({ state: 'building', evidence_root: null });
  });
  it('a row appended after completion is detected: the cached root is no longer returned as complete', async () => {
    const run = setup(), root = await finish(run.engine('a'));
    expect(await verifyEvidence(run.store, binding)).toMatchObject({ ok: true, root, items: TOTAL, pages: 6 });
    append(run.db, 'zzzz');
    expect(await verifyEvidence(run.store, binding)).toEqual({ ok: false, reason: 'uncovered' });
    expect(await run.engine('b').step()).toEqual({ kind: 'refused', reason: 'coverage' });
  });
  it('a complete run is verifiable by publish: stored pages recompute from the item rows to the sealed root', async () => {
    const run = small(1203), root = await finish(run.engine('a'));
    const rows = run.db.prepare('SELECT item_key AS key, item_json AS json FROM pub_evidence_item ORDER BY item_key').all() as { key: string; json: string }[];
    expect(rows).toHaveLength(1203);
    const digests = []; for (let i = 0; i < rows.length; i += 500) digests.push(hex(pageBytes(rows.slice(i, i + 500))));
    expect(hex(rootBytes(digests))).toBe(root);
    expect(await verifyEvidence(run.store, binding)).toEqual({ ok: true, root, items: 1203, pages: 3 });
  });
  it('verification refuses a run that is not complete, a different binding, a doctored page and an empty generation', async () => {
    const run = small(40), engine = run.engine('a');
    expect(await verifyEvidence(run.store, binding)).toEqual({ ok: false, reason: 'not-complete' });
    await engine.step();
    expect(await verifyEvidence(run.store, binding)).toEqual({ ok: false, reason: 'not-complete' });
    await finish(engine);
    expect(await verifyEvidence(run.store, { ...binding, manifestSha256: 'c'.repeat(64) })).toEqual({ ok: false, reason: 'binding-mismatch' });
    run.db.exec(`DROP TRIGGER pub_evidence_page_update_seal`);
    run.db.exec(`UPDATE pub_evidence_page SET page_sha256 = '${'0'.repeat(64)}'`);
    expect(await verifyEvidence(run.store, binding)).toEqual({ ok: false, reason: 'uncovered' });
    const none = setup({ producer: producer(false, 0) });
    const root = await finish(none.engine('a'));
    expect(await verifyEvidence(none.store, binding)).toEqual({ ok: true, root, items: 0, pages: 0 });
  });
  it('an unaltered build still completes and a second store over the same database sees the same coverage', async () => {
    const db = database();
    const first = d1EvidenceStore(d1(db)), second = d1EvidenceStore(d1(db));
    let now = 0;
    const engine = createEvidenceEngine({ binding, store: first, producer: producer(false, 700), clock: () => now, leaseId: 'a', leaseMs: 100, bounds: BOUNDS });
    const root = await finish(engine);
    expect(await verifyEvidence(second, binding)).toMatchObject({ ok: true, root });
  });
});
