import { describe, expect, it } from 'vitest';
import type { CloudR2 } from '../../../src/lib/storage/cloud/bindings.ts';
import { PAGE_SIZE } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { OriginalsEvidenceError, createOriginalsProducer, originalRefs, type OriginalRef, type OriginalsProducerOptions } from '../../../src/lib/publication/hosted/originals-evidence.ts';
import { checkEvidenceItem } from '../../../src/lib/publication/hosted/rules.ts';
import { setup, finish } from '../evidence/harness.ts';
import { bytesOf, seed, sha, type Seeded } from './harness.ts';

// The producer, alone and under U3's real engine. Synthetic bytes in the repo's MemoryR2 double.

const options = (s: Seeded, over: Partial<OriginalsProducerOptions> = {}): OriginalsProducerOptions =>
  ({ refs: async () => s.refs, bucket: s.r2, batch: 4, windowBytes: 1 << 20, maxObjectBytes: 1 << 20, ...over });
async function drain(p: ReturnType<typeof createOriginalsProducer>) {
  const out: { key: string; observation: unknown }[] = [];
  for (let cursor: string | null = null; ;) {
    const r = await p(cursor);
    if (r.done) return out;
    out.push({ key: r.key, observation: r.observation }); cursor = r.nextCursor;
  }
}
const failure = async (work: Promise<unknown>) => work.then(() => null, (e: unknown) => e instanceof OriginalsEvidenceError ? e.code : (() => { throw e; })());

describe('what the producer records', () => {
  it('gives one original/<assetId> item per ref with the sha256 it hashed, the size it read and the etag of that same read', async () => {
    const s = await seed(9);
    const items = await drain(createOriginalsProducer(options(s)));
    expect(items.map(i => i.key)).toEqual(s.refs.map(r => `original/${r.assetId}`));
    for (const [n, i] of items.entries()) {
      const ref = s.refs[n]!, head = await s.r2.head(s.keyOf(ref));
      expect(i.observation).toEqual({ kind: 'original', assetId: ref.assetId, sha256: ref.sha256, size: ref.size, etag: head!.etag });
    }
  });

  it('is an observation the v2 rules accept, bound to its key, and nothing else', async () => {
    const s = await seed(1);
    const [{ key, observation }] = await drain(createOriginalsProducer(options(s)));
    const input = { caseId: 'c', clientId: 'k', manifestSha256: 'a'.repeat(64), rendererVersion: 'r', resultsVersion: 'v', validatorVersion: 'x' };
    const row = (o: unknown, k = key!) => ({ key: k, json: JSON.stringify({ input, observation: o }), baseline: null });
    const bound = { clientId: 'k', caseId: 'c', resultsVersion: 'v', manifestSha256: 'a'.repeat(64) };
    expect(checkEvidenceItem(row(observation), bound)).toMatchObject({ key, observation });
    const o = observation as Record<string, unknown>;
    for (const bad of [{ ...o, extra: 1 }, { ...o, sha256: 'xyz' }, { ...o, size: -1 }, { ...o, size: 1.5 }, { ...o, etag: '' }, { ...o, etag: 'e'.repeat(129) }, { ...o, assetId: '' },
      { kind: 'original', assetId: o.assetId, sha256: o.sha256, size: o.size }]) expect(checkEvidenceItem(row(bad), bound), JSON.stringify(bad)).toBeNull();
    // Every leaf deleted, nulled and retyped is refused.
    for (const leaf of ['kind', 'assetId', 'sha256', 'size', 'etag']) {
      const { [leaf]: _gone, ...without } = o;
      for (const changed of [without, { ...o, [leaf]: null }, { ...o, [leaf]: typeof o[leaf] === 'number' ? String(o[leaf]) : 7 }, { ...o, [leaf]: { x: 1 } }]) expect(checkEvidenceItem(row(changed), bound), `${leaf} ${JSON.stringify(changed)}`).toBeNull();
    }
    expect(checkEvidenceItem(row(observation, 'original/other'), bound)).toBeNull();
    expect(checkEvidenceItem(row(observation, `preview/${(o as { assetId: string }).assetId}`), bound)).toBeNull();
    expect(checkEvidenceItem({ ...row(observation), baseline: false }, bound)).toBeNull();
  });
});

describe('bounded reads', () => {
  const metered = (s: Seeded) => {
    const m = { gets: [] as string[], inFlight: 0, peak: 0, bytesInFlight: 0, peakBytes: 0 };
    const bucket: Pick<CloudR2, 'get'> = { get: async key => {
      m.gets.push(key); m.inFlight++; m.peak = Math.max(m.peak, m.inFlight);
      const o = await s.r2.get(key);
      m.bytesInFlight += o?.size ?? 0; m.peakBytes = Math.max(m.peakBytes, m.bytesInFlight);
      await new Promise(r => setTimeout(r, 2));
      m.inFlight--; m.bytesInFlight -= o?.size ?? 0;
      return o;
    } };
    return { m, bucket };
  };

  it('reads at most `batch` originals at a time and each distinct object once', async () => {
    const s = await seed(10);
    const { m, bucket } = metered(s);
    await drain(createOriginalsProducer(options(s, { bucket, batch: 3 })));
    expect(m.peak).toBeLessThanOrEqual(3);
    expect(m.peak).toBeGreaterThan(1);
    expect(m.gets.sort()).toEqual(s.refs.map(s.keyOf).sort());
  });

  it('holds no more than `windowBytes` of originals in flight, down to one at a time', async () => {
    const s = await seed(8, 1000);
    const { m, bucket } = metered(s);
    await drain(createOriginalsProducer(options(s, { bucket, batch: 8, windowBytes: 2500 })));
    expect(m.peakBytes).toBeLessThanOrEqual(2 * 1004);
    const alone = metered(s);
    await drain(createOriginalsProducer(options(s, { bucket: alone.bucket, batch: 8, windowBytes: 1 })));
    expect(alone.m.peak).toBe(1);
  });

  it('reads an object two assets share once, and records it for both', async () => {
    const s = await seed(3);
    const shared: OriginalRef = { assetId: 'sub-op-00001b', sha256: s.refs[1]!.sha256, size: s.refs[1]!.size };
    const refs = [s.refs[0]!, s.refs[1]!, shared, s.refs[2]!];
    const { m, bucket } = metered(s);
    const items = await drain(createOriginalsProducer(options(s, { refs: async () => refs, bucket })));
    expect(items).toHaveLength(4);
    expect(m.gets.filter(k => k === s.keyOf(shared))).toHaveLength(1);
    expect((items[1]!.observation as { etag: string }).etag).toBe((items[2]!.observation as { etag: string }).etag);
  });

  it('asks for the refs once per producer, and again after a failure to ask', async () => {
    const s = await seed(4);
    let asked = 0, fail = true;
    const p = createOriginalsProducer(options(s, { refs: async () => { asked++; if (fail) { fail = false; throw new Error('d1 down'); } return s.refs; } }));
    await expect(p(null)).rejects.toThrow('d1 down');
    expect(await drain(p)).toHaveLength(4);
    expect(asked).toBe(2);
  });
});

describe('an original that cannot be hashed stops the build instead of being skipped', () => {
  it('missing, other size, same size other content, over budget, unreachable', async () => {
    const s = await seed(5, 64);
    const run = (over: Partial<OriginalsProducerOptions> = {}) => failure(drain(createOriginalsProducer(options(s, over))));
    expect(await run()).toBeNull();
    const [r0, r1] = s.refs as [OriginalRef, OriginalRef];
    const saved = new Uint8Array(s.r2.objects.get(s.keyOf(r0))!.bytes);
    s.r2.objects.delete(s.keyOf(r0));
    expect(await run()).toBe('missing');
    await s.r2.put(s.keyOf(r0), saved, { sha256: r0.sha256 });
    expect(await run()).toBeNull();
    s.r2.tamper(s.keyOf(r1), b => b.subarray(1));
    expect(await run()).toBe('size-mismatch');
    const other = bytesOf(777, r1.size);
    await s.r2.put(s.keyOf(r1), other, { sha256: sha(other) });
    expect(await run()).toBe('content-mismatch');
    const fresh = await seed(5, 64);
    const over = (extra: Partial<OriginalsProducerOptions>) => failure(drain(createOriginalsProducer(options(fresh, extra))));
    expect(await over({ maxObjectBytes: 10 })).toBe('over-budget');
    expect(await over({ bucket: { get: async () => { throw new Error('r2 down'); } } })).toBe('storage-unavailable');
    expect(await over({ bucket: { get: async key => { const o = await fresh.r2.get(key); return o && { ...o, arrayBuffer: async () => { throw new Error('stream reset'); } }; } } })).toBe('storage-unavailable');
  });

  it('does not download an object whose size is not the recorded one', async () => {
    const s = await seed(3);
    s.r2.tamper(s.keyOf(s.refs[1]!), b => b.subarray(1));
    let bodies = 0;
    const bucket: Pick<CloudR2, 'get'> = { get: async key => { const o = await s.r2.get(key); return o && { ...o, arrayBuffer: async () => { bodies++; return o.arrayBuffer(); } }; } };
    expect(await failure(drain(createOriginalsProducer(options(s, { bucket, batch: 1 }))))).toBe('size-mismatch');
    expect(bodies).toBe(1);
  });

  it('refuses refs it cannot key: an unsafe asset id, a repeat, an order the engine would refuse, a malformed digest', async () => {
    const s = await seed(3);
    const run = (refs: OriginalRef[]) => failure(drain(createOriginalsProducer(options(s, { refs: async () => refs }))));
    const [a, b, c] = s.refs as [OriginalRef, OriginalRef, OriginalRef];
    expect(await run([a, b, c])).toBeNull();
    expect(await run([{ ...a, assetId: 'a/b' }, b, c])).toBe('invalid-ref');
    expect(await run([{ ...a, assetId: 'a b' }, b, c])).toBe('invalid-ref');
    expect(await run([{ ...a, assetId: '' }, b, c])).toBe('invalid-ref');
    expect(await run([a, a, c])).toBe('invalid-ref');
    expect(await run([b, a, c])).toBe('invalid-ref');
    expect(await run([a, { ...b, sha256: 'ABC' }, c])).toBe('invalid-ref');
    expect(await run([a, { ...b, size: -1 }, c])).toBe('invalid-ref');
  });

  it('refuses a cursor from other refs rather than guessing a position', async () => {
    const s = await seed(3);
    expect(await failure(createOriginalsProducer(options(s))('sub-op-99999'))).toBe('refs-changed');
  });
});

describe('originalRefs', () => {
  const entry = (assetId: string, bytes: Uint8Array, over: Record<string, unknown> = {}) => ({ assetId, sha256: sha(bytes), size: bytes.byteLength, originalSize: bytes.byteLength, objectKey: `orig/${sha(bytes)}`, ...over });
  it('keeps the originals the package names, one per asset, in asset order', () => {
    const [x, y, z] = [bytesOf(1), bytesOf(2), bytesOf(3)];
    const folder = [entry('sub-b', y), entry('sub-a', x), entry('sub-c', z), entry('sub-a', x)];
    expect(originalRefs(folder, [{ sha256: sha(x) }, { sha256: sha(y) }]).map(r => r.assetId)).toEqual(['sub-a', 'sub-b']);
  });
  it('refuses a folder original it cannot trust instead of leaving it out', () => {
    const x = bytesOf(1), assets = [{ sha256: sha(x) }];
    const refuse = (e: ReturnType<typeof entry>[]) => { try { originalRefs(e, assets); return null; } catch (error) { return (error as OriginalsEvidenceError).code; } };
    expect(refuse([entry('sub-a', x, { objectKey: 'orig/other' })])).toBe('invalid-ref');
    expect(refuse([entry('sub-a', x, { originalSize: 1 })])).toBe('invalid-ref');
    expect(refuse([entry('sub-a', x, { assetId: 'a/b' })])).toBe('invalid-ref');
    expect(refuse([entry('sub-a', x), entry('sub-a', x, { size: x.byteLength + 1, originalSize: x.byteLength + 1 })])).toBe('invalid-ref');
    expect(refuse([])).toBeNull();
  });
});

describe('under U3\'s engine', () => {
  // Rows are about 250 bytes; 600 holds two, so most steps end on an item that would cross the bound and the next step produces it again.
  const BOUNDS = { itemsPerStep: 5, bytesPerStep: 600 };
  async function build(s: Seeded, kill: (step: number) => boolean, fresh: boolean) {
    const run = setup({ bounds: BOUNDS });
    const make = () => createOriginalsProducer(options(s, { batch: 3 }));
    const throughout = make();
    let engine = run.engine('builder-0', { producer: fresh ? make() : throughout }), generation = 0, root: string | null = null, steps = 0;
    for (; steps < 500 && root === null; steps++) {
      if (kill(steps)) { run.advance(101); engine = run.engine(`builder-${++generation}`, { producer: fresh ? make() : throughout }); }
      const r = await engine.step();
      if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind);
    }
    if (!root) throw new Error('no root');
    return { run, root, steps };
  }

  it('gives the same root, and the same rows once each, however it is killed and resumed, with a fresh producer per step or one throughout', async () => {
    const s = await seed(23);
    const whole = await build(s, () => false, false);
    expect(whole.steps).toBeGreaterThan(8);
    for (const [kill, fresh] of [[() => true, true], [(n: number) => n % 3 === 1, true], [(n: number) => n % 2 === 0, false]] as const) {
      const again = await build(s, kill, fresh);
      expect(again.root).toBe(whole.root);
      const rows = again.run.db.prepare('SELECT item_key FROM pub_evidence_item ORDER BY item_key').all() as { item_key: string }[];
      expect(rows.map(r => r.item_key)).toEqual(s.refs.map(r => `original/${r.assetId}`));
    }
  });

  it('writes a key once: a producer called again for the boundary item never reaches an insert that the seals would refuse', async () => {
    const s = await seed(12);
    const calls = new Map<string, number>();
    const inner = createOriginalsProducer(options(s));
    const run = setup({ bounds: BOUNDS, producer: async cursor => { const r = await inner(cursor); if (!r.done) calls.set(r.key, (calls.get(r.key) ?? 0) + 1); return r; } });
    const root = await finish(run.engine('builder'));
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect([...calls.values()].some(n => n > 1)).toBe(true);
    expect((run.db.prepare('SELECT count(*) AS n FROM pub_evidence_item').get() as { n: number }).n).toBe(12);
  });

  it('stops at an original that cannot be hashed, writes nothing for it, and goes on once it can', async () => {
    const s = await seed(10);
    const doomed = s.refs[6]!, saved = new Uint8Array(s.r2.objects.get(s.keyOf(doomed))!.bytes);
    s.r2.objects.delete(s.keyOf(doomed));
    const run = setup({ bounds: BOUNDS, producer: createOriginalsProducer(options(s)) });
    const engine = run.engine('builder', { producer: createOriginalsProducer(options(s)) });
    let thrown: unknown = null;
    try { await finish(engine); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(OriginalsEvidenceError);
    expect((thrown as OriginalsEvidenceError).code).toBe('missing');
    const keys = () => (run.db.prepare('SELECT item_key FROM pub_evidence_item ORDER BY item_key').all() as { item_key: string }[]).map(r => r.item_key);
    expect(keys().includes(`original/${doomed.assetId}`)).toBe(false);
    await s.r2.put(s.keyOf(doomed), saved, { sha256: doomed.sha256 });
    run.advance(101);
    expect(await finish(run.engine('later', { producer: createOriginalsProducer(options(s)) }))).toMatch(/^[0-9a-f]{64}$/);
    expect(keys()).toEqual(s.refs.map(r => `original/${r.assetId}`));
  });

  it('seals a run of more than one page of originals', async () => {
    const s = await seed(PAGE_SIZE + 25, 8);
    const run = setup({ bounds: { itemsPerStep: 100, bytesPerStep: 1 << 20 } });
    const root = await finish(run.engine('builder', { producer: createOriginalsProducer(options(s, { batch: 16 })) }));
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect((run.db.prepare('SELECT count(*) AS n FROM pub_evidence_page').get() as { n: number }).n).toBe(2);
  });
});
