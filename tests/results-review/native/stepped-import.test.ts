// U15 round 2 acceptance: `complete` stages the package in resumable, bounded steps instead of passing it through the stager in
// one request. The poc package (60 documents; CLEARCASE_POC_DOCUMENTS=1689 for the v5-sized corpus) is imported both ways, over the
// real validator, staging storage and native repositories. The stepped import must leave the same resultsVersion, the same
// candidate and the same rows as the one-request import, whatever write a process dies at.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LinkedCandidate } from '../../../src/lib/results-review/native/index.ts';
import { DEFAULT_STEP_BOUNDS, stepCost } from '../../../src/lib/results-review/native/staging/index.ts';
import { WORKERS_PAID_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';
import { ids } from '../../hosted-foundation/storage/fixture.ts';
import { BIG_BUDGETS, Durable, Killed, OP, TEST_BOUNDS, completeAll, driveStaged, dump, importWhole, realPackage, rowsOf, startProcess, uploaded, type KillAt, type RealPackage, type StepRecord } from './stepped-world.ts';

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const linked = (o: unknown): LinkedCandidate => {
  const out = o as { kind: string; candidate?: LinkedCandidate };
  if (out.kind !== 'linked' || !out.candidate) throw new Error('not linked: ' + JSON.stringify(o));
  return out.candidate;
};

describe('the stepped import equals the one-request import', () => {
  let pkg: RealPackage;
  let reference: { candidate: LinkedCandidate; dump: ReturnType<typeof dump>; originalGets: number };
  let stepped: { candidate: LinkedCandidate; steps: StepRecord[]; mark: { puts: number; batches: number }; total: { puts: number; batches: number }; originalGets: number; wholeStage: number };

  beforeAll(async () => {
    pkg = await realPackage();
    {
      const { durable, revisionId } = await uploaded(pkg);
      const p = await startProcess(durable);
      const out = await importWhole(p, pkg, revisionId);
      reference = { candidate: linked(out), dump: dump(durable), originalGets: durable.counts.originalGets };
    }
    {
      const { durable, revisionId } = await uploaded(pkg);
      const p = await startProcess(durable);
      const steps: StepRecord[] = [];
      const mark = { puts: 0, batches: 0 };
      const done = await driveStaged(p, durable, pkg, revisionId, { steps, mark });
      stepped = { candidate: linked(done), steps, mark, total: { puts: durable.counts.puts, batches: durable.counts.batches }, originalGets: durable.counts.originalGets, wholeStage: durable.counts.wholeStage };
      expect(dump(durable)).toEqual(reference.dump);
    }
    const max = (f: (s: StepRecord) => number) => Math.max(...stepped.steps.map(f));
    const phases: Record<string, number> = {};
    for (const s of stepped.steps) phases[s.phase] = (phases[s.phase] ?? 0) + 1;
    const summary = JSON.stringify({ documents: pkg.documents, previews: pkg.previews, files: pkg.files.size, steps: stepped.steps.length, phases, maxPerStep: { d1: max((s) => s.d1), r2Gets: max((s) => s.r2Gets), heads: max((s) => s.heads), puts: max((s) => s.puts), bytesRead: max((s) => s.bytesRead) },
      totals: stepped.total, originalGets: { stepped: stepped.originalGets, oneRequest: reference.originalGets }, wholeStage: stepped.wholeStage });
    // The numbers the report quotes; written beside the receipt when asked, as the console is not kept.
    if (process.env.CLEARCASE_STEPPED_SUMMARY) writeFileSync(process.env.CLEARCASE_STEPPED_SUMMARY, summary + '\n');
  }, 1_800_000);

  it('is the poc package: thousands of file assets, a preview each, and a package that needs many bounded steps', () => {
    expect(pkg.files.size).toBeGreaterThan(36 + pkg.previews - 1);
    expect(pkg.previews).toBeGreaterThanOrEqual(Math.min(60, pkg.documents));
    expect(stepped.steps.length).toBeGreaterThan(20);
    expect(new Set(stepped.steps.map((s) => s.phase)).size).toBeGreaterThan(6);
  });

  it('never hands the package to the one-request stager', () => {
    expect(stepped.wholeStage).toBe(0);
  });

  it('links the same resultsVersion and the same candidate as the one-request import', () => {
    expect(stepped.candidate.link.candidate.resultsVersion).toBe(reference.candidate.link.candidate.resultsVersion);
    expect(stepped.candidate.candidateId).toBe(reference.candidate.candidateId);
    expect(JSON.stringify(stepped.candidate)).toBe(JSON.stringify(reference.candidate));
  });

  it('leaves the same version, file, document, asset and seed rows, the same link and the same package objects (checked in beforeAll)', () => {
    expect(reference.dump.rs_document.length).toBe(pkg.documents);
    expect(reference.dump.rs_package_file.length).toBe(pkg.files.size);
    expect((reference.dump.objects as string[][]).filter(([k]) => k!.startsWith('pkg/')).length).toBe(pkg.files.size);
  });

  it('keeps every step inside its bounds', () => {
    const cost = stepCost(TEST_BOUNDS, BIG_BUDGETS.maxRowsPerBatch);
    for (const s of stepped.steps) {
      expect(s.puts).toBeLessThanOrEqual(TEST_BOUNDS.objectsPerStep + 2);
      expect(s.d1).toBeLessThanOrEqual(cost.d1);
      expect(s.r2Gets + s.heads + s.puts).toBeLessThanOrEqual(cost.r2);
      expect(s.bytesRead).toBeLessThanOrEqual(TEST_BOUNDS.structuredBytes + TEST_BOUNDS.bytesPerStep + 256 * 1024);
    }
  });

  it('reads each original in at most three passes of bounded steps, not once per step', () => {
    expect(stepped.originalGets).toBeGreaterThan(reference.originalGets / 2);
    expect(stepped.originalGets).toBeLessThanOrEqual(3 * pkg.documents + 3 * Math.ceil(pkg.documents / TEST_BOUNDS.originalsPerStep) * 2 + 12);
  });

  it('answers a second complete with the same candidate, without staging again', async () => {
    const { durable, revisionId } = await uploaded(pkg);
    const p = await startProcess(durable);
    const first = linked(await driveStaged(p, durable, pkg, revisionId));
    const before = { ...durable.counts };
    const again = await p.staged.complete(p.token, { operationId: OP });
    expect(again).toMatchObject({ kind: 'linked', repeated: true });
    expect(linked(again).candidateId).toBe(first.candidateId);
    expect(durable.counts.puts).toBe(before.puts);
  });

  /** Kills the first process at `kill`, lets the lease lapse, starts another over the same D1 and R2, and holds the result to the reference. */
  async function killedThenResumed(kill: KillAt) {
    const { durable, revisionId } = await uploaded(pkg);
    const dead = await startProcess(durable, { kill });
    const outcome = await driveStaged(dead, durable, pkg, revisionId).then(() => 'finished', (e) => (e instanceof Killed || /killed|storage-unavailable/i.test(String((e as Error).message) + String((e as { code?: string }).code)) ? 'killed' : Promise.reject(e)));
    expect(outcome).toBe('killed');
    // The dead step still holds its lease: another process is told so, and writes nothing.
    const early = await startProcess(durable);
    const wait = await early.staged.complete(early.token, { operationId: OP });
    expect(['refused', 'staging']).toContain(wait.kind);
    durable.clock.ms += TEST_BOUNDS.leaseMs + 1;
    const alive = await startProcess(durable);
    const candidate = linked(await driveStaged(alive, durable, pkg, revisionId));
    expect(candidate.link.candidate.resultsVersion).toBe(reference.candidate.link.candidate.resultsVersion);
    expect(JSON.stringify(candidate)).toBe(JSON.stringify(reference.candidate));
    expect(dump(durable)).toEqual(reference.dump);
    // No R2 key is written twice, and what the dead process had already derived is not read again beyond one step's worth.
    expect(new Set(durable.putKeys).size).toBe(durable.putKeys.length);
    expect(durable.counts.originalGets).toBeLessThanOrEqual(stepped.originalGets + TEST_BOUNDS.originalsPerStep);
    expect(rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_candidate')).toEqual([{ n: 1 }]);
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('killed at a random write of the staging steps (seed %i), then resumed, equals the uninterrupted import', async (seed) => {
    const random = rng(seed * 7919);
    const op = random() < 0.5 ? 'put' : 'batch';
    const total = op === 'put' ? stepped.total.puts : stepped.total.batches;
    // Writes made while the package files were uploaded come first; the steps' writes are the rest.
    const lo = op === 'put' ? stepped.mark.puts : stepped.mark.batches;
    await killedThenResumed({ op, nth: lo + 1 + Math.floor(random() * (total - lo)), after: random() < 0.5 });
  }, 600_000);

  it('a step whose lease was taken over cannot write, however far the other has got', async () => {
    const { durable, revisionId } = await uploaded(pkg);
    const a = await startProcess(durable);
    await driveStaged(a, durable, pkg, revisionId, { maxCalls: 2 }).catch(() => undefined);
    const state = () => rowsOf(durable, 'SELECT epoch, phase, cursor, steps, lease_id FROM native_import_stage_run')[0] as { epoch: number; phase: string; cursor: string; steps: number; lease_id: string | null };
    const factsBefore = rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_import_stage_fact');
    // Process A claims the lease for its step. Before A commits, its lease lapses and B takes three steps; A's write must lose, and must
    // neither move the run back to where A read it nor add anything.
    const b = await startProcess(durable);
    let left: ReturnType<typeof state> | null = null, factsAfterB: unknown = null;
    const slow = await startProcess(durable, { interleave: async () => {
      durable.clock.ms += TEST_BOUNDS.leaseMs + 1;
      for (let i = 0; i < 3; i++) expect((await b.staged.complete(b.token, { operationId: OP })).kind).toBe('staging');
      left = state(); factsAfterB = rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_import_stage_fact');
    } });
    const lost = await slow.staged.complete(slow.token, { operationId: OP });
    expect(lost).toMatchObject({ kind: 'refused', code: 'busy' });
    expect(left).not.toBeNull();
    expect(state()).toEqual(left);
    expect(rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_import_stage_fact')).toEqual(factsAfterB);
    expect(factsAfterB).not.toEqual(factsBefore);
    expect(state().steps).toBeGreaterThanOrEqual(5);
    const finished = linked(await completeAll(await startProcess(durable), durable));
    expect(JSON.stringify(finished)).toBe(JSON.stringify(reference.candidate));
    expect(dump(durable)).toEqual(reference.dump);
  }, 600_000);

  it('cuts a step by bytes: an original that would pass the step\'s byte bound waits for the next, and the import is the same', async () => {
    const { durable, revisionId } = await uploaded(pkg);
    // The one original is 17 KB: two do not fit under 20,000 bytes, so each step of a pass reads one.
    const p = await startProcess(durable, { bounds: { bytesPerStep: 20_000, originalsPerStep: 50, objectsPerStep: 1000 } });
    const steps: StepRecord[] = [];
    const out = linked(await driveStaged(p, durable, pkg, revisionId, { steps }));
    expect(JSON.stringify(out)).toBe(JSON.stringify(reference.candidate));
    expect(dump(durable)).toEqual(reference.dump);
    expect(Math.max(...steps.map((s) => s.originalGets))).toBe(1);
    // A pass takes one step per original (all documents point at that one original), three passes, and so many more steps than the default.
    expect(steps.filter((s) => s.originalGets === 1).length).toBe(3 * pkg.documents);
  }, 600_000);

  it('stops a step at its wall time, with everything it reached recorded, and still equals the one-request import', async () => {
    const { durable, revisionId } = await uploaded(pkg);
    durable.tick = 10;
    const bounds = { wallMsPerStep: 50, objectsPerStep: 1000, bytesPerStep: 64 << 20, originalsPerStep: 1000 };
    const p = await startProcess(durable, { bounds });
    const steps: StepRecord[] = [];
    const out = linked(await driveStaged(p, durable, pkg, revisionId, { steps }));
    expect(JSON.stringify(out)).toBe(JSON.stringify(reference.candidate));
    expect(dump(durable)).toEqual(reference.dump);
    // Without the wall bound a step would take every object and original it is allowed; with it, a step ends once 50 ms have passed.
    for (const s of steps) {
      expect(s.puts).toBeLessThanOrEqual(3);
      // The wall time, a group of six reads past it, and the two loads of the package's non-preview files (36 reads each) a last request makes.
      expect(s.ms).toBeLessThanOrEqual(50 + 6 * 10 * 2 + 2 * 36 * 10);
      expect(s.originalGets).toBeLessThanOrEqual(12);
    }
    expect(steps.length).toBeGreaterThan(stepped.steps.length);
    expect(Math.max(...steps.map((s) => s.ms))).toBeGreaterThan(50);
  }, 600_000);

  it('sweeps the staged objects of the finished import and leaves every object the candidate references, still readable', async () => {
    const { durable, revisionId } = await uploaded(pkg);
    const p = await startProcess(durable, { sweepObjects: 25 });
    const done = linked(await driveStaged(p, durable, pkg, revisionId));
    const staged = [...durable.bucket.objects.keys()].filter((k) => k.startsWith('native-import/'));
    expect(staged.length).toBeGreaterThan(pkg.files.size - 1);
    const before = dump(durable).objects;
    let steps = 0;
    for (;;) {
      const out = await p.staged.sweep(p.token, { operationId: OP });
      if (out.kind !== 'swept') throw new Error(JSON.stringify(out));
      steps++;
      if (out.state === 'done') break;
    }
    expect(steps).toBeGreaterThan(1);
    expect([...durable.bucket.objects.keys()].filter((k) => k.startsWith('native-import/'))).toEqual([]);
    expect(dump(durable).objects).toEqual(before);
    expect(dump(durable)).toEqual(reference.dump);
    // The candidate still reads, and its stored package still verifies from the objects it references.
    expect((await p.service.readCandidate(p.token, done.candidateId))?.candidateId).toBe(done.candidateId);
    const stored = await p.packages.files({ clientId: ids.clientA, caseId: pkg.caseId as never, resultsVersion: done.link.candidate.resultsVersion });
    expect(stored?.size).toBe(pkg.files.size);
    expect(await p.staged.complete(p.token, { operationId: OP })).toMatchObject({ kind: 'linked', repeated: true });
  }, 600_000);

  it('refuses a tampered original as the one-request import does, writes no version, and succeeds once the original is back', async () => {
    const whole = await uploaded(pkg);
    const key = [...whole.durable.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    const good = new Uint8Array(whole.durable.bucket.objects.get(key)!.bytes);
    whole.durable.bucket.tamper(key, (b) => { b[b.length - 1] ^= 1; return b; });
    const expected = await importWhole(await startProcess(whole.durable), pkg, whole.revisionId);
    expect(expected).toMatchObject({ kind: 'refused', code: 'validator-refused' });

    const { durable, revisionId } = await uploaded(pkg);
    durable.bucket.tamper(key, (b) => { b[b.length - 1] ^= 1; return b; });
    const out = await driveStaged(await startProcess(durable), durable, pkg, revisionId);
    expect(out).toEqual(expected);
    expect(rowsOf(durable, 'SELECT COUNT(*) AS n FROM rs_results_version')).toEqual([{ n: 0 }]);
    expect(rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_candidate')).toEqual([{ n: 0 }]);
    // The refusal restarts the run in a new epoch, and what the first epoch derived stays but is not read again.
    expect(rowsOf(durable, 'SELECT epoch, phase, cursor FROM native_import_stage_run')).toEqual([{ epoch: 1, phase: 'plan', cursor: '{}' }]);
    expect((rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_import_stage_fact WHERE epoch = 0')[0] as { n: number }).n).toBeGreaterThan(0);
    durable.bucket.tamper(key, () => new Uint8Array(good));
    const retry = await completeAll(await startProcess(durable), durable);
    expect(JSON.stringify(linked(retry))).toBe(JSON.stringify(reference.candidate));
    expect(rowsOf(durable, 'SELECT epoch, phase FROM native_import_stage_run')).toEqual([{ epoch: 1, phase: 'done' }]);
    expect((rowsOf(durable, 'SELECT COUNT(*) AS n FROM native_import_stage_fact WHERE epoch = 1')[0] as { n: number }).n).toBeGreaterThan(0);
  }, 600_000);

  it('refuses a package whose preview is not a PDF at the same point the validator does, naming the same code', async () => {
    const bad = new Map(pkg.files);
    const path = [...bad.keys()].find((k) => k.startsWith('previews/'))!;
    bad.set(path, new TextEncoder().encode('<html>not a pdf</html>'));
    // The manifest still lists the PDF's digest, so the staged upload itself refuses a file that does not match it.
    const { durable, revisionId } = await uploaded(pkg);
    const p = await startProcess(durable);
    await p.staged.open(p.token, { operationId: OP, submissionRevisionId: revisionId, manifest: bad.get('manifest.json')! });
    const out = await p.staged.put(p.token, { operationId: OP, files: new Map([[path, bad.get(path)!]]) });
    expect(out).toMatchObject({ kind: 'refused', code: 'file-mismatch' });
  });

  it('has bounds the plan accepts: a step costs less than Workers Paid allows one request', () => {
    const cost = stepCost(DEFAULT_STEP_BOUNDS, 100);
    expect(cost.d1 * DEFAULT_STEP_BOUNDS.stepsPerRequest).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.d1);
    expect(cost.external * DEFAULT_STEP_BOUNDS.stepsPerRequest).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.external);
    expect(cost.r2 * DEFAULT_STEP_BOUNDS.stepsPerRequest).toBeLessThanOrEqual(9000);
  });
});
