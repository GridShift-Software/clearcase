// Review probes 1 and 2, promoted to regressions. Real service/stager and D1 adapters; local SQLite/R2 doubles, not provider evidence.
import { expect, it } from 'vitest';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { sha256Hex, Durable, startProcess, RecordingStager, submissionOf } from './staged-world.ts';
import * as stepped from './stepped-world.ts';
import { DEFAULT_STEP_BOUNDS, STAGED_WORK_CAP, loadStaged, stagedCompleteCost, STAGED_SESSION_TTL_MS, d1StagingLedger } from '../../../src/lib/results-review/native/staging/index.ts';
import { WORKERS_PAID_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';

it('probe 1: asset aliases, not package-file count, bound plan fact writes', async () => {
  const bytes = pdf('one original');
  const assets: Record<string, unknown> = {};
  for (let i = 2; i <= 16000; i++) assets[`OD-${String(i).padStart(5, '0')}`] = { kind: 'file', path: 'Letters/a.pdf', size: bytes.length, sha256: sha256Hex(bytes), mediaType: 'application/pdf', textStatus: 'pending' };
  const fx = buildFixture({ docs: [{ ref: 'OD-00001', path: 'Letters/a.pdf', bytes }], assets });
  const pkg: stepped.RealPackage = { caseId: fx.caseId, files: fx.files, original: { path: 'Letters/a.pdf', bytes }, previews: 0, documents: 1 };
  const { durable, revisionId } = await stepped.uploaded(pkg);
  const bounds = { ...DEFAULT_STEP_BOUNDS, stepsPerRequest: 1 };
  const p = await stepped.startProcess(durable, { bounds, requestBudget: { ...WORKERS_PAID_REQUEST, rowsPerBatch: 100 } });
  const steps: stepped.StepRecord[] = [];
  await expect(stepped.driveStaged(p, durable, pkg, revisionId, { maxCalls: 1, steps })).rejects.toThrow('complete never finished');
  const advertised = stagedCompleteCost(bounds, 100, { assets: 16000, links: 16000 });
  expect(steps[0].d1).toBeLessThanOrEqual(advertised.d1);
  expect(durable.db.rows("SELECT key FROM native_import_stage_fact WHERE pass = 'plan'").length).toBeLessThanOrEqual(bounds.rowsPerStep);
  // The work may be split, but none of the 16,000 aliases may disappear.
  expect((await stepped.completeAll(p, durable, { steps })).kind).toBe('linked');
  expect(durable.db.rows("SELECT key FROM native_import_stage_fact WHERE pass = 'plan'")).toHaveLength(16000);
  const links = durable.db.rows<{ value: string }>("SELECT value FROM native_import_stage_fact WHERE pass = 'links'");
  expect(links).toHaveLength(16000);
  for (const row of links) expect(JSON.parse(row.value).packageRefs).toHaveLength(1);
  for (const s of steps) {
    expect(s.identity).toBeLessThanOrEqual(advertised.external);
    expect(s.d1).toBeLessThanOrEqual(advertised.d1);
    expect(s.r2Gets + s.puts + s.heads).toBeLessThanOrEqual(advertised.r2);
  }
}, 300_000);

it('probe 2: atomic reserve/release and a killed writer after its sweep passed', async () => {
  const bytes = pdf('quota');
  const fx = buildFixture({ docs: [{ ref: 'OD-001', path: 'Letters/a.pdf', bytes }] });
  const cap = [...fx.files.values()].reduce((n, b) => n + b.length, 0);
  const durable = new Durable();
  const submissions = await submissionOf('case-a', [{ path: 'Letters/a.pdf', size: bytes.length, sha256: sha256Hex(bytes) }], 'subrev-probe');
  let now = Date.parse('2026-01-01T00:00:00Z');
  const process = () => startProcess({ durable, caseId: 'case-a', submissions, stager: new RecordingStager(), maxStagedBytes: cap, now: () => new Date(now) });
  const ledger = d1StagingLedger(durable.db, { rowsPerBatch: 3 });
  const open = (p: Awaited<ReturnType<typeof process>>, operationId: string) => p.service.staged!.open(p.token, { operationId, submissionRevisionId: 'subrev-probe', manifest: fx.files.get('manifest.json')! });
  const p = await process();
  const sweep = async (q = p) => {
    const out = await q.service.staged!.sweepExpired(q.token);
    if (out.kind !== 'swept') throw new Error(JSON.stringify(out));
    return out;
  };
  const pair = await Promise.all([open(p, 'op-cap-a'), open(p, 'op-cap-b')]);
  expect(pair.filter(x => x.kind === 'progress')).toHaveLength(1);
  expect(pair.filter(x => x.kind === 'refused' && x.code === 'staging-quota')).toHaveLength(1);
  now += STAGED_SESSION_TTL_MS + 1;
  while ((await sweep()).operationId !== null) {}
  expect(await ledger.held({ clientId: 'client-a' })).toBe(0);
  const [file, data] = [...fx.files].filter(([path]) => path !== 'manifest.json').sort((x, y) => y[1].length - x[1].length)[0];
  const stored = () => [...durable.r2.objects].filter(([key]) => key.startsWith('native-import/')).reduce((n, [, o]) => n + o.bytes.length, 0);
  for (let i = 0; i < 8; i++) {
    const op = `op-orphan-${i}`;
    expect((await open(p, op)).kind).toBe('progress');
    now += STAGED_SESSION_TTL_MS - 1;
    const original = durable.r2.put.bind(durable.r2);
    let entered!: () => void, release!: () => void;
    const atPut = new Promise<void>(r => { entered = r; });
    const go = new Promise<void>(r => { release = r; });
    durable.r2.put = async (...args) => { entered(); await go; await original(...args); throw new Error('killed immediately after object write'); };
    const pending = p.service.staged!.put(p.token, { operationId: op, files: new Map([[file, data]]) }).catch(e => e);
    await atPut;
    now += 2;
    try {
      await p.service.staged!.sweepExpired(p.token);
      // A sweep cannot release capacity while this writer can still land bytes.
      expect(await ledger.held({ clientId: 'client-a' })).toBe(cap);
      expect((await open(p, `op-too-soon-${i}`))).toMatchObject({ kind: 'refused', code: 'staging-quota' });
    } finally {
      release();
      await pending;
      durable.r2.put = original;
    }
    expect(stored()).toBeLessThanOrEqual(await ledger.held({ clientId: 'client-a' }));
    // Fresh process: a dead writer's capacity must remain held until reclamation is safe.
    const resumed = await process();
    for (let calls = 0; calls < 10; calls++) {
      if ((await sweep(resumed)).operationId === null) break;
    }
    expect(stored()).toBeLessThanOrEqual(await ledger.held({ clientId: 'client-a' }));
    expect(stored()).toBeLessThanOrEqual(cap);
    // Allow any conservative writer/reclamation grace before the next repetition.
    now += STAGED_SESSION_TTL_MS + 1;
    while ((await sweep(resumed)).operationId !== null) {}
    expect(await ledger.held({ clientId: 'client-a' })).toBe(0);
    expect(stored()).toBe(0);
  }
}, 120_000);

it('refuses parsed aliases above the reviewed cap before dataset, fact or original reads', async () => {
  const bytes = pdf('cap');
  const asset = { kind: 'file', path: 'Letters/a.pdf', size: bytes.length, sha256: sha256Hex(bytes), mediaType: 'application/pdf', textStatus: 'pending' };
  const assets = Object.fromEntries(Array.from({ length: STAGED_WORK_CAP.assets }, (_, i) => [`OD-${String(i + 2).padStart(5, '0')}`, asset]));
  const fx = buildFixture({ docs: [{ ref: 'OD-00001', path: asset.path, bytes }], assets });
  const manifest = fx.files.get('manifest.json')!;
  const reads: string[] = [];
  const out = await loadStaged({ manifest, files: new Map([...fx.files].map(([path, b]) => [path, { size: b.length, sha256: sha256Hex(b), pdf: false }])),
    read: async path => { reads.push(path); return fx.files.get(path)!; } }, DEFAULT_STEP_BOUNDS.structuredBytes);
  expect(out).toMatchObject({ ok: false, code: 'too-large', detail: [expect.stringContaining('20001 rows')] });
  expect(reads).toEqual(['assets.json']);
  const counts = { assets: STAGED_WORK_CAP.assets, links: STAGED_WORK_CAP.links };
  expect(stagedCompleteCost(DEFAULT_STEP_BOUNDS, 100, counts)).toEqual(stagedCompleteCost(DEFAULT_STEP_BOUNDS, 100));
  for (const invalid of [{ ...counts, assets: counts.assets + 1 }, { ...counts, links: counts.links + 1 }, { ...counts, assets: NaN }]) {
    expect(() => stagedCompleteCost(DEFAULT_STEP_BOUNDS, 100, invalid)).toThrow('asset/link row cap');
  }
});

async function writerWorld() {
  const bytes = pdf('writer');
  const fx = buildFixture({ docs: [{ ref: 'OD-001', path: 'Letters/a.pdf', bytes }] });
  const durable = new Durable();
  const cap = [...fx.files.values()].reduce((n, b) => n + b.length, 0);
  const submissions = await submissionOf('case-a', [{ path: 'Letters/a.pdf', size: bytes.length, sha256: sha256Hex(bytes) }]);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const start = () => startProcess({ durable, caseId: 'case-a', submissions, stager: new RecordingStager(), maxStagedBytes: cap, now: () => new Date(now) });
  const p = await start();
  const ledger = d1StagingLedger(durable.db, { rowsPerBatch: 3 });
  const key = { clientId: id('client', 'client-a'), caseId: id('case', 'case-a'), operationId: 'op-writers' };
  const open = () => p.service.staged!.open(p.token, { operationId: key.operationId, submissionRevisionId: 'subrev-staged', manifest: fx.files.get('manifest.json')! });
  return { durable, fx, cap, p, ledger, key, open, start, expire: () => { now += STAGED_SESSION_TTL_MS + 1; } };
}

it('fences both simultaneous writers before the first cleanup listing; one settlement cannot release the other', async () => {
  const w = await writerWorld();
  expect((await w.open()).kind).toBe('progress');
  const files = [...w.fx.files].filter(([path]) => path !== 'manifest.json');
  const original = w.durable.r2.put.bind(w.durable.r2);
  const releases: (() => void)[] = [];
  let entered!: () => void;
  const both = new Promise<void>(resolve => { entered = resolve; });
  w.durable.r2.put = async (...args) => {
    await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) entered(); });
    return original(...args);
  };
  const pending = files.slice(0, 2).map(file => w.p.service.staged!.put(w.p.token, { operationId: w.key.operationId, files: new Map([file]) }));
  await both;
  w.expire();
  const sweep = () => w.p.service.staged!.sweep(w.p.token, { operationId: w.key.operationId });
  try {
    expect(await sweep()).toMatchObject({ state: 'sweeping', deleted: 0, remaining: 1 });
    expect(await w.ledger.beginWrite(w.key)).toBeNull(); // Atomic tombstone gate, not just a service-side check.
    releases[0]();
    await pending[0];
    const ended = w.durable.db.rows<{ key: string }>("SELECT key FROM native_import_stage_fact WHERE pass = 'writer-end'");
    // Retrying one settlement is idempotent and cannot settle a different writer.
    for (const row of ended) await w.ledger.endWrite({ ...w.key, writerId: row.key });
    expect(await w.ledger.writing(w.key)).toBe(true);
    expect(await sweep()).toMatchObject({ state: 'sweeping', deleted: 0 });
    expect(await w.ledger.held(w.key)).toBe(w.cap);
  } finally {
    for (const release of releases) release();
    await Promise.all(pending);
    w.durable.r2.put = original;
  }
  expect(await w.ledger.writing(w.key)).toBe(false);
  expect(await sweep()).toMatchObject({ state: 'done' });
  expect(await w.ledger.held(w.key)).toBe(0);
  expect(w.durable.r2.objects.size).toBe(0);
});

it('holds a killed writer across process restart and arbitrarily many TTLs when its settlement was never recorded', async () => {
  const w = await writerWorld();
  expect((await w.open()).kind).toBe('progress');
  const file = [...w.fx.files].find(([path]) => path !== 'manifest.json')!;
  const prepare = w.durable.db.prepare.bind(w.durable.db);
  // Kill at the settlement boundary after R2 stored bytes. A truly dead isolate cannot execute its finally block either.
  w.durable.db.prepare = sql => { if (sql.includes("'writer-end', w.key")) throw new Error('killed before settlement'); return prepare(sql); };
  await expect(w.p.service.staged!.put(w.p.token, { operationId: w.key.operationId, files: new Map([file]) })).rejects.toThrow();
  w.durable.db.prepare = prepare;
  const resumed = await w.start();
  for (let i = 0; i < 8; i++) {
    w.expire();
    expect(await resumed.service.staged!.sweep(resumed.token, { operationId: w.key.operationId })).toMatchObject({ state: 'sweeping', deleted: 0 });
    expect(await w.ledger.held(w.key)).toBe(w.cap);
    const stored = [...w.durable.r2.objects.values()].reduce((n, o) => n + o.bytes.length, 0);
    expect(stored).toBeLessThanOrEqual(await w.ledger.held(w.key));
  }
  expect(await w.ledger.writing(w.key)).toBe(true);
});

it('reserves an open manifest writer too, including an R2 failure after its tombstone', async () => {
  const w = await writerWorld();
  const original = w.durable.r2.put.bind(w.durable.r2);
  let entered!: () => void, release!: () => void;
  const atPut = new Promise<void>(resolve => { entered = resolve; });
  const go = new Promise<void>(resolve => { release = resolve; });
  w.durable.r2.put = async (...args) => { entered(); await go; await original(...args); throw new Error('killed after manifest write'); };
  const pending = w.open().catch(e => e);
  await atPut;
  w.expire();
  try {
    expect(await w.p.service.staged!.sweep(w.p.token, { operationId: w.key.operationId })).toMatchObject({ state: 'sweeping', deleted: 0 });
    expect(await w.ledger.held(w.key)).toBe(w.cap);
  } finally { release(); await pending; w.durable.r2.put = original; }
  const resumed = await w.start();
  expect(await resumed.service.staged!.sweepExpired(resumed.token)).toMatchObject({ state: 'done', operationId: w.key.operationId });
  expect(await w.ledger.held(w.key)).toBe(0);
  expect(w.durable.r2.objects.size).toBe(0);
});
