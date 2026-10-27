import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, canonicalJson, pageBytes, rootBytes } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { TOTAL, binding, finish, producer, setup } from './harness.ts';

const hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const seeded = (seed: number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32; };
const count = (db: ReturnType<typeof setup>['db'], table = 'pub_evidence_item') => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

async function baselineRoot() {
  const run = setup(); const root = await finish(run.engine('baseline')); run.db.close(); return root;
}

describe('crash safety inside a step', () => {
  for (const when of ['before', 'after'] as const) {
    it(`a build killed ${when} a random commit, across seeds, resumes to the uninterrupted root`, async () => {
      const root = await baselineRoot();
      for (const seed of [3, 41, 977, 31337]) {
        const rand = seeded(seed);
        let armed = -1, batches = 0;
        const hook = { [when]: () => { if (batches++ === armed) { armed = -1; throw new Error('killed'); } } };
        const run = setup({ hook });
        armed = 1 + Math.floor(rand() * 120);
        let leases = 0, engine = run.engine(`life-${leases}`), result: string | null = null;
        for (let step = 0; step < 5000 && result === null; step++) {
          try { const r = await engine.step(); if (r.kind === 'complete') result = r.root; else expect(['progress', 'leased']).toContain(r.kind); }
          catch (error) { expect((error as Error).message).toBe('killed'); run.advance(101); engine = run.engine(`life-${++leases}`); armed = batches + 1 + Math.floor(rand() * 60); }
        }
        expect(leases).toBeGreaterThan(0);
        expect(result).toBe(root);
        expect(count(run.db)).toBe(TOTAL);
        run.db.close();
      }
    });
  }
  it('a build whose commit landed but whose acknowledgement was lost does not double-write on retry with the same lease', async () => {
    const root = await baselineRoot();
    let batches = 0;
    const run = setup({ hook: { after: () => { if (++batches === 7) throw new Error('lost acknowledgement'); } } });
    const engine = run.engine('same');
    let result: string | null = null;
    for (let step = 0; step < 5000 && result === null; step++) {
      try { const r = await engine.step(); if (r.kind === 'complete') result = r.root; } catch { /* retry as the same builder */ }
    }
    expect(result).toBe(root);
    expect(count(run.db)).toBe(TOTAL);
  });
});

describe('leases', () => {
  it('a builder whose lease was taken over while its producer call was in flight cannot write', async () => {
    const run = setup();
    const slow = producer();
    let inFlight = false;
    const first = run.engine('first', { producer: async cursor => { if (cursor === '40' && !inFlight) { inFlight = true; run.advance(101); await run.engine('second').step(); } return slow(cursor); } });
    expect((await first.step()).kind).toBe('progress');
    expect((await first.step()).kind).toBe('progress');
    const before = count(run.db);
    const result = await first.step();
    expect(result.kind).toBe('leased');
    expect(count(run.db)).toBe(before + 20);
    const run2 = run.db.prepare('SELECT lease_token FROM pub_evidence_run').get() as { lease_token: string };
    expect(run2.lease_token).toBe('second');
  });
  it('two builders sharing one lease id cannot both commit the same range', async () => {
    const run = setup();
    const slow = producer();
    let nested = false;
    const outer = run.engine('shared', { producer: async cursor => { if (cursor === '5' && !nested) { nested = true; await run.engine('shared').step(); } return slow(cursor); } });
    const result = await outer.step();
    expect(result.kind).toBe('leased');
    expect(count(run.db)).toBe(20);
    expect(await finish(outer)).toBe(await baselineRoot());
    expect(count(run.db)).toBe(TOTAL);
  });
  it('the store refuses a commit from a builder that does not hold the lease', async () => {
    const run = setup();
    await run.engine('holder').step();
    const claim = await run.store.claim(binding, 'intruder', run.now(), run.now() + 100);
    expect(claim.kind).toBe('leased');
    const forged = await run.store.commit(binding, 'intruder', { cursor: '0' }, { items: [{ key: 'zzzz', json: '{}' }], page: null, nextCursor: 'x', leaseUntilMs: run.now() + 100 });
    expect(forged).toBe(false);
    expect(count(run.db)).toBe(20);
  });
  it('a complete run answers every caller with its root and writes nothing', async () => {
    const run = setup();
    const root = await finish(run.engine('a'));
    const rows = count(run.db);
    run.advance(10_000);
    const again = await run.engine('b').step();
    expect(again).toEqual({ kind: 'complete', root });
    expect(count(run.db)).toBe(rows);
  });
});

describe('bounds', () => {
  it('no step writes more than the item or byte bound', async () => {
    const run = setup({ bounds: { itemsPerStep: 7, bytesPerStep: 1500 } });
    let lastItems = 0, lastBytes = 0, steps = 0;
    const bytes = () => (run.db.prepare('SELECT coalesce(sum(length(CAST(item_key AS BLOB)) + length(CAST(item_json AS BLOB))), 0) AS n FROM pub_evidence_item').get() as { n: number }).n;
    for (; steps < 5000; steps++) {
      const r = await run.engine('b').step();
      const items = count(run.db), size = bytes();
      expect(items - lastItems).toBeLessThanOrEqual(7);
      expect(size - lastBytes).toBeLessThanOrEqual(1500);
      lastItems = items; lastBytes = size;
      if (r.kind === 'complete') break;
      expect(r.kind).toBe('progress');
    }
    expect(lastItems).toBe(TOTAL);
  });
  it('an observation too large for a step is refused and nothing is written', async () => {
    const huge = async (cursor: string | null) => cursor === null ? { done: false as const, nextCursor: '1', key: '000000', observation: { text: 'x'.repeat(5000) } } : { done: true as const };
    const run = setup({ producer: huge, bounds: { itemsPerStep: 10, bytesPerStep: 1000 } });
    expect(await run.engine('a').step()).toEqual({ kind: 'refused', reason: 'item-too-large' });
    expect(count(run.db)).toBe(0);
  });
  it('refuses nonsense or unbounded bounds', () => {
    const run = setup();
    for (const bounds of [{ itemsPerStep: 0, bytesPerStep: 100 }, { itemsPerStep: 501, bytesPerStep: 100 }, { itemsPerStep: 1.5, bytesPerStep: 100 }, { itemsPerStep: 10, bytesPerStep: 0 }, { itemsPerStep: 10, bytesPerStep: 2 ** 21 }])
      expect(() => setup({ bounds }).engine('x')).toThrow(RangeError);
    run.db.close();
  });
});

describe('integrity and canonicalisation', () => {
  it('pages are 500 rows, each digest is the documented sha256 over its canonical rows, and the root is the sha256 over the page digests', async () => {
    const run = setup();
    const root = await finish(run.engine('a'));
    const pages = run.db.prepare('SELECT page_number, page_sha256, item_count FROM pub_evidence_page ORDER BY page_number').all() as { page_number: number; page_sha256: string; item_count: number }[];
    expect(pages.map(p => p.item_count)).toEqual([500, 500, 500, 500, 500, 500]);
    const items = run.db.prepare('SELECT item_key, item_json FROM pub_evidence_item ORDER BY item_key').all() as { item_key: string; item_json: string }[];
    pages.forEach((page, i) => expect(page.page_sha256).toBe(hex(pageBytes(items.slice(i * 500, (i + 1) * 500).map(r => ({ key: r.item_key, json: r.item_json }))))));
    expect(root).toBe(hex(rootBytes(pages.map(p => p.page_sha256))));
    expect(root).toBe((run.db.prepare('SELECT evidence_root AS r FROM pub_evidence_run').get() as { r: string }).r);
    // Every row carries its exact input binding.
    expect(JSON.parse(items[0]!.item_json).input).toEqual({ caseId: 'case', clientId: 'client', manifestSha256: 'a'.repeat(64), rendererVersion: 'renderer', resultsVersion: 'version', validatorVersion: 'validator' });
  });
  it('a final partial page is sealed and a run with no items completes with the empty root', async () => {
    const some = setup({ producer: producer(false, 501) });
    await finish(some.engine('a'));
    expect((some.db.prepare('SELECT item_count AS n FROM pub_evidence_page ORDER BY page_number').all() as { n: number }[]).map(r => r.n)).toEqual([500, 1]);
    const none = setup({ producer: producer(false, 0) });
    expect(await finish(none.engine('a'))).toBe(hex(rootBytes([])));
  });
  it('the root depends on the exact inputs but not on how the build was paced', async () => {
    const root = await baselineRoot();
    const paced = setup({ bounds: { itemsPerStep: 3, bytesPerStep: 700 } });
    expect(await finish(paced.engine('a'))).toBe(root);
    const regenerated = setup(); // same inputs, another generation
    expect(await finish(regenerated.engine('a', { binding: { ...binding, generation: 'generation-2' } }))).toBe(root);
    for (const changed of [{ manifestSha256: 'c'.repeat(64) }, { validatorVersion: 'validator-2' }, { rendererVersion: 'renderer-2' }, { resultsVersion: 'version-2' }]) {
      const other = setup();
      expect(await finish(other.engine('a', { binding: { ...binding, ...changed } }))).not.toBe(root);
    }
  });
  it('refuses to continue a run under different inputs for the same candidate and generation', async () => {
    const run = setup();
    await run.engine('a').step();
    expect(await run.engine('a', { binding: { ...binding, manifestSha256: 'd'.repeat(64) } }).step()).toEqual({ kind: 'refused', reason: 'binding-mismatch' });
  });
  it('refuses keys that are out of order, repeated, or outside the ordered ASCII alphabet', async () => {
    const make = (keys: string[]) => async (cursor: string | null) => { const n = cursor === null ? 0 : Number(cursor); return n >= keys.length ? { done: true as const } : { done: false as const, nextCursor: String(n + 1), key: keys[n]!, observation: { n } }; };
    for (const keys of [['b', 'a'], ['a', 'a'], ['a', 'é'], ['', 'a']]) {
      const run = setup({ producer: make(keys) });
      expect((await run.engine('a').step()).kind).toBe('refused');
      expect(count(run.db)).toBe(0);
    }
  });
  it('canonical JSON sorts keys and refuses values with no stable encoding', () => {
    expect(canonicalJson({ b: [1, { z: null, a: true }], a: 'é\n' })).toBe('{"a":"é\\n","b":[1,{"a":true,"z":null}]}');
    for (const bad of [1.5, NaN, Infinity, undefined, { a: undefined }, 2 ** 60, new Date(0), new Map(), '\ud800', () => 1, [undefined], -0])
      expect(() => canonicalJson(bad)).toThrow(RangeError);
  });
});

describe('incremental sha256', () => {
  it('matches the platform digest at every length and split', () => {
    const rand = seeded(7);
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 70_000]) {
      const data = randomBytes(length);
      let h = new Sha256();
      let at = 0;
      while (at < length) { const n = Math.min(length - at, Math.floor(rand() * 150)); h.update(data.subarray(at, at + n)); at += n; if (rand() < 0.3) h = Sha256.restore(JSON.parse(JSON.stringify(h.snapshot()))); }
      expect(h.digestHex()).toBe(hex(data));
    }
  });
});
