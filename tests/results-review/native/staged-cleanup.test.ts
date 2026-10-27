// U15 round 2: staged objects are deleted once their import is finished (a candidate exists) or abandoned (the session is older than
// its time to live), in bounded steps, and never while another live session of the case still needs the same bytes.
import { describe, expect, it } from 'vitest';
import { STAGED_SESSION_TTL_MS, planBatches, type StagedOutcome } from '../../../src/lib/results-review/native/staging/index.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { Durable, Killed, RecordingStager, sha256Hex, startProcess, submissionOf, type Kill, type Process } from './staged-world.ts';

const OP_A = 'op-staged-aaaa-0b7c2f3e1d2a4c5b';
const OP_B = 'op-staged-bbbb-0b7c2f3e1d2a4c5b';
const REVISION = 'subrev-staged';
const REVISION_B = 'subrev-staged-b';
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-25T06:00:00.000Z');

function small(tag = 'a') {
  const docs = [1, 2, 3, 4, 5].map((i) => ({ ref: `OD-00${i}`, path: `Letters/${tag}-${i}.pdf`, bytes: pdf(`original ${tag} ${i}`) }));
  return { docs, fx: buildFixture({ docs, tag }) };
}
const stagedKeys = (d: Durable) => [...d.r2.objects.keys()].filter((k) => k.startsWith('native-import/')).sort();

async function world(o: { now?: () => Date; sweepObjects?: number; kill?: Kill | null; durable?: Durable } = {}) {
  const { docs, fx } = small();
  const other = small('b');
  const durable = o.durable ?? new Durable();
  const readerA = await submissionOf('case-a', docs.map((d) => ({ path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength })), REVISION);
  const readerB = await submissionOf('case-a', other.docs.map((d) => ({ path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength })), REVISION_B);
  const reader = { finalized: (a: Parameters<typeof readerA.finalized>[0]) => (a.revisionId === REVISION_B ? readerB.finalized(a) : readerA.finalized(a)) };
  const start = (more: { now?: () => Date; kill?: Kill | null } = {}) => startProcess({ durable, caseId: 'case-a', stager: new RecordingStager(), submissions: reader, maxBatchFiles: 4,
    sweepObjects: o.sweepObjects ?? 3, now: o.now, ...more });
  return { durable, fx, docs, other: other.fx, start };
}
async function upload(p: Process, op: string, fx: { files: ReadonlyMap<string, Uint8Array> }, only: readonly string[] | null = null, revision = REVISION) {
  const staged = p.service.staged!;
  const opened = await staged.open(p.token, { operationId: op, submissionRevisionId: revision, manifest: fx.files.get('manifest.json')! });
  if (opened.kind !== 'progress') throw new Error('open refused ' + JSON.stringify(opened));
  const paths = [...fx.files.keys()].filter((x) => x !== 'manifest.json' && (only === null || only.includes(x))).sort();
  for (const batch of planBatches(paths.map((x) => [x, fx.files.get(x)!.byteLength] as const), staged.bounds)) {
    const out = await staged.put(p.token, { operationId: op, files: new Map(batch.map((x) => [x, fx.files.get(x)!] as const)) });
    if (out.kind !== 'progress') throw new Error('put refused ' + JSON.stringify(out));
  }
}
const sweepAll = async (p: Process, op: string) => {
  const steps: { deleted: number; remaining: number; state: string }[] = [];
  for (;;) {
    const out = await p.service.staged!.sweep(p.token, { operationId: op });
    if (out.kind !== 'swept') throw new Error('sweep refused ' + JSON.stringify(out));
    steps.push(out);
    if (out.state === 'done') return steps;
    if (steps.length > 200) throw new Error('sweep never finished');
  }
};

describe('after complete', () => {
  it('deletes the staged objects in bounded steps and leaves everything a candidate references', async () => {
    const { durable, fx, start } = await world();
    const p = await start();
    await upload(p, OP_A, fx);
    const done = await p.service.staged!.complete(p.token, { operationId: OP_A });
    expect(done.kind).toBe('linked');
    const staged = stagedKeys(durable);
    expect(staged.length).toBe(fx.files.size); // the manifest and every file, each once
    const others = [...durable.r2.objects.keys()].filter((k) => !k.startsWith('native-import/'));

    const steps = await sweepAll(p, OP_A);
    expect(steps.length).toBeGreaterThan(1);
    for (const s of steps) expect(s.deleted).toBeLessThanOrEqual(3);
    expect(steps.reduce((n, s) => n + s.deleted, 0)).toBe(staged.length);
    expect(stagedKeys(durable)).toEqual([]);
    expect([...durable.r2.objects.keys()].filter((k) => !k.startsWith('native-import/'))).toEqual(others);
    // The candidate and the ledger rows stay: the work is finished, not undone.
    expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
    expect(durable.db.rows('SELECT 1 FROM native_import_staged_file')).toHaveLength(fx.files.size - 1);
    // A repeat of a finished sweep deletes nothing.
    const again = await p.service.staged!.sweep(p.token, { operationId: OP_A });
    expect(again).toMatchObject({ kind: 'swept', deleted: 0, remaining: 0, state: 'done' });
    // The finished import still answers.
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked', repeated: true });
  });

  it('is not run for an import that has not finished', async () => {
    const { durable, fx, start } = await world();
    const p = await start();
    await upload(p, OP_A, fx);
    const before = stagedKeys(durable);
    expect(await p.service.staged!.sweep(p.token, { operationId: OP_A })).toMatchObject({ kind: 'refused', code: 'not-finished' });
    expect(await p.service.staged!.sweep(p.token, { operationId: 'op-staged-zzzz-0b7c2f3e1d2a4c5b' })).toMatchObject({ kind: 'refused', code: 'session-not-found' });
    expect(stagedKeys(durable)).toEqual(before);
  });

  it('keeps a byte another live session of the case still needs', async () => {
    const { durable, fx, start } = await world();
    const p = await start();
    await upload(p, OP_A, fx);
    // A second session of the same package, begun and only partly sent: it shares every object by content.
    const paths = [...fx.files.keys()].filter((x) => x !== 'manifest.json').sort();
    await upload(p, OP_B, fx, paths.slice(0, 2));
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked' });
    const staged = stagedKeys(durable);
    expect(staged.length).toBe(fx.files.size);

    await sweepAll(p, OP_A);
    // Everything B has recorded, and its manifest, is still there.
    const needed = new Set(durable.db.rows<{ sha256: string }>("SELECT sha256 FROM native_import_staged_file WHERE operation_id = 'op-staged-bbbb-0b7c2f3e1d2a4c5b'").map((r) => r.sha256));
    needed.add(durable.db.rows<{ manifest_sha256: string }>("SELECT manifest_sha256 FROM native_import_session WHERE operation_id = 'op-staged-bbbb-0b7c2f3e1d2a4c5b'")[0]!.manifest_sha256);
    const left = stagedKeys(durable);
    for (const sha of needed) expect(left.some((k) => k.endsWith('/' + sha))).toBe(true);
    // Objects no live session needs are gone: the files B has not been sent.
    expect(left.length).toBeLessThan(staged.length);
    expect(left.length).toBe(needed.size);
    // B can still be finished from what was kept.
    const s = p.service.staged!;
    const rest = paths.slice(2);
    for (const batch of planBatches(rest.map((x) => [x, fx.files.get(x)!.byteLength] as const), s.bounds)) await s.put(p.token, { operationId: OP_B, files: new Map(batch.map((x) => [x, fx.files.get(x)!] as const)) });
    // B finishing is a link of a results version A already has: refused, but not for want of bytes.
    expect(await s.complete(p.token, { operationId: OP_B })).toMatchObject({ kind: 'refused', code: 'candidate-exists' });
  });

  it('survives a process killed during the sweep and finishes without deleting anything twice that matters', async () => {
    for (const phase of ['before-r2-delete', 'after-r2-delete'] as const) for (const nth of [1, 2, 4]) {
      const { durable, fx, start } = await world();
      const p = await start();
      await upload(p, OP_A, fx);
      await p.service.staged!.complete(p.token, { operationId: OP_A });
      const dead = await start({ kill: { phase, nth } });
      await expect(sweepAll(dead, OP_A)).rejects.toSatisfy((e) => e instanceof Killed || /killed|storage-unavailable/i.test(String((e as Error).message) + String((e as { code?: string }).code)));
      const alive = await start();
      await sweepAll(alive, OP_A);
      expect(stagedKeys(durable)).toEqual([]);
      expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
    }
  });
});

describe('after the session time to live', () => {
  it('deletes an abandoned session\'s objects in bounded steps and leaves a younger one alone', async () => {
    let now = T0;
    const { durable, fx, other, start } = await world({ now: () => new Date(now) });
    const p = await start();
    await upload(p, OP_A, fx);
    const keysA = stagedKeys(durable);
    now = T0 + 5 * DAY;
    const young = await start({ now: () => new Date(now) });
    await upload(young, OP_B, other, null, REVISION_B);
    // Everything B needs, including what it shares with A by content.
    const keysB = [...new Set([...other.files.values()].map((b) => `native-import/client-a/case-a/${sha256Hex(b)}`))].sort();
    expect(keysB.every((k) => stagedKeys(durable).includes(k))).toBe(true);
    expect(keysB.length).toBeGreaterThan(0);

    // Eight days after A was opened and three after B: only A is past a seven-day life.
    now = T0 + 8 * DAY;
    expect(STAGED_SESSION_TTL_MS).toBe(7 * DAY);
    const later = await start({ now: () => new Date(now) });
    const swept: number[] = [];
    for (let i = 0; i < 100; i++) {
      const out = await later.service.staged!.sweepExpired(later.token);
      if (out.kind !== 'swept') throw new Error(JSON.stringify(out));
      swept.push(out.deleted);
      if (out.operationId === null) break;
    }
    expect(Math.max(...swept)).toBeLessThanOrEqual(3);
    expect(swept.length).toBeGreaterThan(2);
    expect(stagedKeys(durable)).toEqual(keysB);
    // A is gone and says so; it cannot be continued. B is unaffected.
    expect(await later.service.staged!.put(later.token, { operationId: OP_A, files: new Map([['assets.json', fx.files.get('assets.json')!]]) })).toMatchObject({ kind: 'refused', code: 'session-expired' });
    expect(await later.service.staged!.complete(later.token, { operationId: OP_A })).toMatchObject({ kind: 'refused', code: 'session-expired' });
    expect(await later.service.staged!.complete(later.token, { operationId: OP_B })).toMatchObject({ kind: 'linked' });
  });

  it('is run a step at a time by the next import that opens', async () => {
    let now = T0;
    const { durable, fx, other, start } = await world({ now: () => new Date(now) });
    const p = await start();
    await upload(p, OP_A, fx);
    const before = stagedKeys(durable).length;
    now = T0 + 8 * DAY;
    const later = await start({ now: () => new Date(now) });
    const opened = await later.service.staged!.open(later.token, { operationId: OP_B, submissionRevisionId: REVISION_B, manifest: other.files.get('manifest.json')! });
    expect(opened).toMatchObject({ kind: 'progress', state: 'open' });
    // One bounded step of A's sweep ran before the open answered (3 objects), and the new session's manifest is there.
    expect(durable.deletes.length).toBeGreaterThan(0);
    expect(durable.deletes.length).toBeLessThanOrEqual(3);
    expect(stagedKeys(durable).length).toBe(before - durable.deletes.length + 1);
    expect(durable.db.rows("SELECT state FROM native_import_cleanup WHERE operation_id = 'op-staged-aaaa-0b7c2f3e1d2a4c5b'")).toEqual([{ state: 'sweeping' }]);
  });

  it('does not touch a session that is still inside its life, or a finished one before it is swept', async () => {
    let now = T0;
    const { durable, fx, start } = await world({ now: () => new Date(now) });
    const p = await start();
    await upload(p, OP_A, fx);
    const before = stagedKeys(durable);
    now = T0 + 6 * DAY;
    const later = await start({ now: () => new Date(now) });
    expect(await later.service.staged!.sweepExpired(later.token)).toMatchObject({ kind: 'swept', operationId: null, deleted: 0 });
    expect(stagedKeys(durable)).toEqual(before);
    const status = await later.service.staged!.status(later.token, { operationId: OP_A }) as Extract<StagedOutcome, { kind: 'progress' }>;
    expect(status.missing).toEqual([]);
  });

  it('does not sweep a session that has a candidate as abandoned: that one is swept as finished, and its candidate stays', async () => {
    let now = T0;
    const { durable, fx, start } = await world({ now: () => new Date(now) });
    const p = await start();
    await upload(p, OP_A, fx);
    expect(await p.service.staged!.complete(p.token, { operationId: OP_A })).toMatchObject({ kind: 'linked' });
    now = T0 + 30 * DAY;
    const later = await start({ now: () => new Date(now) });
    for (let i = 0; i < 50; i++) { const out = await later.service.staged!.sweepExpired(later.token); if (out.kind === 'swept' && out.operationId === null) break; }
    expect(stagedKeys(durable)).toEqual([]);
    expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
    expect(await later.service.staged!.complete(later.token, { operationId: OP_A })).toMatchObject({ kind: 'linked', repeated: true });
  });
});
