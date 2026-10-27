// U15 fix round 1. The reviewer's three probes (review-evidence/u15-ef1ded8d) as regression tests, then the reclamation the review asked
// for: a drain that also takes finished imports, objects written before their row, and a cap on staged bytes.
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { resultsVersionOf } from '../../../src/lib/case-package/hash.ts';
import { checkManifest } from '../../../src/lib/results-review/native/staging/manifest.ts';
import { loadStaged } from '../../../src/lib/results-review/native/staging/load.ts';
import { DEFAULT_STEP_BOUNDS, STAGED_SESSION_TTL_MS, planBatches, stepCost } from '../../../src/lib/results-review/native/staging/index.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { Durable, Killed, RecordingStager, sha256Hex, startProcess, submissionOf, type Kill, type Process } from './staged-world.ts';
import * as stepped from './stepped-world.ts';

const stagedKeys = (d: Durable) => [...d.r2.objects.keys()].filter((k) => k.startsWith('native-import/')).sort();

async function upload(p: Process, op: string, fx: { files: ReadonlyMap<string, Uint8Array> }, revision: string, only: readonly string[] | null = null) {
  const opened = await p.service.staged!.open(p.token, { operationId: op, submissionRevisionId: revision, manifest: fx.files.get('manifest.json')! });
  if (opened.kind !== 'progress') throw new Error('open refused ' + JSON.stringify(opened));
  const files = [...fx.files].filter(([path]) => path !== 'manifest.json' && (only === null || only.includes(path)));
  for (const batch of planBatches(files.map(([path, data]) => [path, data.length] as const), p.service.staged!.bounds)) {
    const out = await p.service.staged!.put(p.token, { operationId: op, files: new Map(batch.map((path) => [path, fx.files.get(path)!])) });
    if (out.kind !== 'progress') throw new Error('put refused ' + JSON.stringify(out));
  }
}
// The store reports a dead bucket call as storage-unavailable; either way the request died after its write.
const killed = (e: unknown) => e instanceof Killed || (e as { code?: string }).code === 'storage-unavailable';
async function drain(p: Process) {
  for (let i = 0; i < 500; i++) {
    const out = await p.service.staged!.sweepExpired(p.token);
    if (out.kind !== 'swept') throw new Error('drain refused ' + JSON.stringify(out));
    if (out.operationId === null) return i;
  }
  throw new Error('the drain never finished');
}

describe('probe 1 (H1): a sweep and a live upload of the same bytes', () => {
  it('keeps every object a session accepted between the sweep\'s check and its delete', async () => {
    const docs = [{ ref: 'OD-001', path: 'Letters/a.pdf', bytes: pdf('original') }];
    const fx = buildFixture({ docs, tag: 'race' });
    const durable = new Durable();
    const submissions = await submissionOf('case-a', docs.map((d) => ({ path: d.path, size: d.bytes.length, sha256: sha256Hex(d.bytes) })), 'revision-probe');
    let p = await startProcess({ durable, caseId: 'case-a', submissions, stager: new RecordingStager(), sweepObjects: 1 });
    const a = 'op-review-a-0b7c2f3e1d2a4c5b', b = 'op-review-b-0b7c2f3e1d2a4c5b';
    await upload(p, a, fx, 'revision-probe');
    expect((await p.service.staged!.complete(p.token, { operationId: a })).kind).toBe('linked');
    p = await startProcess({ durable, caseId: 'case-a', submissions, stager: new RecordingStager(), sweepObjects: 1, requestBudget: { d1: 31, external: 1000, rowsPerBatch: 3 } });
    // B is opened and sent whole after A's sweep has decided what to delete and before it deletes it.
    const remove = durable.r2.delete.bind(durable.r2);
    let raced = false;
    durable.r2.delete = async (key) => {
      if (!raced) { raced = true; await upload(p, b, fx, 'revision-probe'); }
      return remove(key);
    };
    for (let i = 0; i < 100; i++) { const out = await p.service.staged!.sweep(p.token, { operationId: a }); if (out.kind !== 'swept' || out.state === 'done') break; }
    expect(raced).toBe(true);
    expect(await p.service.staged!.status(p.token, { operationId: b })).toMatchObject({ kind: 'progress', missingFiles: 0 });
    // Every file B accepted still has its bytes, and they still verify: B's status, and a read of each, are true.
    const rows = durable.db.rows<{ sha256: string }>(`SELECT sha256 FROM native_import_staged_file WHERE operation_id = '${b}'`);
    expect(rows.length).toBe(fx.files.size - 1);
    const left = stagedKeys(durable);
    expect(rows.filter((r) => !left.some((k) => k.endsWith('/' + r.sha256)))).toEqual([]);
    for (const k of left) expect(sha256Hex(durable.r2.objects.get(k)!.bytes)).toBe(k.split('/').pop());
  });
});

describe('probe 2 (H2): a stage that finished but was never linked', () => {
  it('verifies the originals again after a kill before the link, and refuses one that changed', async () => {
    const pkg = await stepped.realPackage();
    const { durable, revisionId } = await stepped.uploaded(pkg);
    const p = await stepped.startProcess(durable);
    const batch = durable.db.batch.bind(durable.db);
    let killed = false;
    durable.db.batch = async (statements) => {
      const run = durable.db.rows<{ phase: string }>('SELECT phase FROM native_import_stage_run')[0];
      if (run?.phase === 'done' && !killed) { killed = true; throw new Error('synthetic kill before link'); }
      return batch(statements);
    };
    await stepped.driveStaged(p, durable, pkg, revisionId).catch(() => undefined);
    expect(killed).toBe(true);
    expect(durable.db.rows('SELECT * FROM native_candidate')).toHaveLength(0);
    expect(durable.db.rows('SELECT phase FROM native_import_stage_run')).toEqual([{ phase: 'done' }]);
    durable.db.batch = batch;
    const key = [...durable.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    durable.bucket.tamper(key, (bytes) => { bytes[bytes.length - 1] ^= 1; return bytes; });
    const wholeRetry = await stepped.importWhole(await stepped.startProcess(durable), pkg, revisionId);
    expect(wholeRetry.kind).toBe('refused');
    const beforeGets = durable.counts.originalGets;
    const resumed = await stepped.completeAll(await stepped.startProcess(durable), durable);
    expect(durable.counts.originalGets - beforeGets).toBeGreaterThan(0);
    expect(resumed.kind).not.toBe('linked');
    expect(durable.db.rows('SELECT * FROM native_candidate')).toHaveLength(0);
  }, 300_000);

  it('links the same candidate after a kill before the link when nothing changed', async () => {
    const pkg = await stepped.realPackage();
    const reference = await stepped.uploaded(pkg);
    const whole = await stepped.driveStaged(await stepped.startProcess(reference.durable), reference.durable, pkg, reference.revisionId);
    expect(whole.kind).toBe('linked');
    const { durable, revisionId } = await stepped.uploaded(pkg);
    const p = await stepped.startProcess(durable);
    const batch = durable.db.batch.bind(durable.db);
    let killed = false;
    durable.db.batch = async (statements) => {
      const run = durable.db.rows<{ phase: string }>('SELECT phase FROM native_import_stage_run')[0];
      if (run?.phase === 'done' && !killed) { killed = true; throw new Error('synthetic kill before link'); }
      return batch(statements);
    };
    await stepped.driveStaged(p, durable, pkg, revisionId).catch(() => undefined);
    expect(killed).toBe(true);
    durable.db.batch = batch;
    const resumed = await stepped.completeAll(await stepped.startProcess(durable), durable);
    expect(resumed).toMatchObject({ kind: 'linked', repeated: false });
    expect(stepped.dump(durable)).toEqual(stepped.dump(reference.durable));
  }, 300_000);
});

describe('probe 3 (M1): the structure a step loads is bounded before any read', () => {
  function wideManifest() {
    const docs = [{ ref: 'OD-001', path: 'Letters/a.pdf', bytes: pdf('original') }];
    const fx = buildFixture({ docs, tag: 'budget' });
    const manifest = JSON.parse(new TextDecoder().decode(fx.files.get('manifest.json')!));
    const data = canonicalBytes({});
    for (let i = 0; i < 4501; i++) manifest.files.push({ path: `datasets/extra-${i}.json`, role: 'dataset', key: `extra-${i}`, kind: 'generated', schema: 'opaque@1', required: false, count: 0, size: data.length, sha256: sha256Hex(data) });
    manifest.files.sort((x: { path: string }, y: { path: string }) => (x.path < y.path ? -1 : 1));
    manifest.resultsVersion = resultsVersionOf({ formatVersion: manifest.formatVersion, caseId: manifest.case.id, inputRevisionId: manifest.inputRevision.id, files: manifest.files });
    return { fx, data, manifest, bytes: canonicalBytes(manifest) };
  }

  it('refuses at open a manifest with more datasets than a package may have', () => {
    const { bytes } = wideManifest();
    const checked = checkManifest(bytes, 'case-a', { maxFiles: 8192, maxFileBytes: 12 << 20, maxPackageBytes: 512 << 20, maxBatchBytes: 12 << 20 });
    expect(checked).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('reads no more than a step\'s stated R2 bound, refusing before the first read', async () => {
    const { fx, data, manifest, bytes } = wideManifest();
    let reads = 0;
    const loaded = await loadStaged({ manifest: bytes, files: new Map(manifest.files.map((f: { path: string; sha256: string; size: number }) => [f.path, { sha256: f.sha256, size: f.size, pdf: false }])),
      read: async (path) => { reads++; return fx.files.get(path) ?? data; } }, DEFAULT_STEP_BOUNDS.structuredBytes);
    expect(reads).toBeLessThanOrEqual(stepCost(DEFAULT_STEP_BOUNDS, 100).r2);
    expect(loaded).toMatchObject({ ok: false, code: 'too-large' });
    expect(reads).toBe(0);
  }, 60_000);
});

// The reclamation of staged objects (M2).
const OP_A = 'op-staged-aaaa-0b7c2f3e1d2a4c5b';
const OP_B = 'op-staged-bbbb-0b7c2f3e1d2a4c5b';
const REVISION = 'subrev-staged';
const REVISION_B = 'subrev-staged-b';
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-25T06:00:00.000Z');

async function world(o: { now?: () => Date; maxStagedBytes?: number } = {}) {
  const make = (tag: string) => { const docs = [1, 2, 3, 4, 5].map((i) => ({ ref: `OD-00${i}`, path: `Letters/${tag}-${i}.pdf`, bytes: pdf(`original ${tag} ${i}`) })); return { docs, fx: buildFixture({ docs, tag }) }; };
  const one = make('a'), two = make('b');
  const durable = new Durable();
  const readerA = await submissionOf('case-a', one.docs.map((d) => ({ path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength })), REVISION);
  const readerB = await submissionOf('case-a', two.docs.map((d) => ({ path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength })), REVISION_B);
  const reader = { finalized: (a: Parameters<typeof readerA.finalized>[0]) => (a.revisionId === REVISION_B ? readerB.finalized(a) : readerA.finalized(a)) };
  const start = (more: { now?: () => Date; kill?: Kill | null } = {}) => startProcess({ durable, caseId: 'case-a', stager: new RecordingStager(), submissions: reader, maxBatchFiles: 4, sweepObjects: 3,
    now: o.now, ...(o.maxStagedBytes ? { maxStagedBytes: o.maxStagedBytes } : {}), ...more });
  return { durable, fx: one.fx, other: two.fx, start };
}
const bytesOf = (fx: { files: ReadonlyMap<string, Uint8Array> }) => [...fx.files.values()].reduce((n, b) => n + b.byteLength, 0);

describe('the drain (M2)', () => {
  it('takes a finished import inside its time to live, a bounded step per call, and leaves the candidate', async () => {
    const { durable, fx, start } = await world();
    const p = await start();
    await upload(p, OP_A, fx, REVISION);
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked' });
    expect(stagedKeys(durable).length).toBe(fx.files.size);
    const steps = await drain(p);
    expect(steps).toBeGreaterThan(1);
    expect(stagedKeys(durable)).toEqual([]);
    expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked', repeated: true });
  });

  it('finds objects written before their acceptance row: a batch killed after its R2 puts', async () => {
    let now = T0;
    const { durable, fx, start } = await world({ now: () => new Date(now) });
    const p = await start();
    await upload(p, OP_A, fx, REVISION, [...fx.files.keys()].filter((x) => x !== 'manifest.json').sort().slice(0, 2));
    // The next batch dies after its objects are written and before its rows are: bytes with no row naming them.
    const dead = await start({ kill: { phase: 'after-r2-put', nth: 1 } });
    const rest = [...fx.files.keys()].filter((x) => x !== 'manifest.json').sort().slice(2, 4);
    await expect(dead.service.staged!.put(dead.token, { operationId: OP_A, files: new Map(rest.map((x) => [x, fx.files.get(x)!] as const)) })).rejects.toSatisfy(killed);
    const rows = durable.db.rows<{ sha256: string }>(`SELECT sha256 FROM native_import_staged_file WHERE operation_id = '${OP_A}'`).map((r) => r.sha256);
    expect(stagedKeys(durable).some((k) => !rows.some((sha) => k.endsWith('/' + sha)) && !k.endsWith('/' + sha256Hex(fx.files.get('manifest.json')!)))).toBe(true);
    now = T0 + STAGED_SESSION_TTL_MS + DAY;
    await drain(await start({ now: () => new Date(now) }));
    expect(stagedKeys(durable)).toEqual([]);
  });

  it('finds a manifest written by an open that died before it answered', async () => {
    let now = T0;
    const { durable, fx, start } = await world({ now: () => new Date(now) });
    const dead = await start({ kill: { phase: 'after-r2-put', nth: 1 } });
    await expect(dead.service.staged!.open(dead.token, { operationId: OP_A, submissionRevisionId: REVISION, manifest: fx.files.get('manifest.json')! })).rejects.toSatisfy(killed);
    expect(stagedKeys(durable).length).toBe(1);
    now = T0 + STAGED_SESSION_TTL_MS + DAY;
    await drain(await start({ now: () => new Date(now) }));
    expect(stagedKeys(durable)).toEqual([]);
  });
});

describe('the staging quota (M2)', () => {
  it('refuses an open whose bytes would pass the cap before anything is written, and admits it once the earlier import is drained', async () => {
    const probe = await world();
    const cap = bytesOf(probe.fx) + Math.floor(bytesOf(probe.other) / 2);
    const { durable, fx, other, start } = await world({ maxStagedBytes: cap });
    const p = await start();
    await upload(p, OP_A, fx, REVISION);
    const before = stagedKeys(durable);
    expect(await p.service.staged!.open(p.token, { operationId: OP_B, submissionRevisionId: REVISION_B, manifest: other.files.get('manifest.json')! })).toMatchObject({ kind: 'refused', code: 'staging-quota' });
    expect(stagedKeys(durable)).toEqual(before);
    expect(durable.db.rows(`SELECT 1 FROM native_import_session WHERE operation_id = '${OP_B}'`)).toHaveLength(0);
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked' });
    await drain(p);
    expect(await p.service.staged!.open(p.token, { operationId: OP_B, submissionRevisionId: REVISION_B, manifest: other.files.get('manifest.json')! })).toMatchObject({ kind: 'progress', state: 'open' });
  });
});
