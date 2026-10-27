// Review probes 1 and 2, promoted to regressions. Real service/stager and D1 adapters; local SQLite/R2 doubles, not provider evidence.
import { expect, it } from 'vitest';
import { buildFixture, pdf } from './fixtures.ts';
import { sha256Hex, Durable, startProcess, RecordingStager, submissionOf } from './staged-world.ts';
import * as stepped from './stepped-world.ts';
import { DEFAULT_STEP_BOUNDS, stagedCompleteCost, STAGED_SESSION_TTL_MS, d1StagingLedger } from '../../../src/lib/results-review/native/staging/index.ts';
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
  const advertised = stagedCompleteCost(bounds, 100);
  expect(steps[0].d1).toBeLessThanOrEqual(advertised.d1);
  // The work may be split, but none of the 16,000 aliases may disappear.
  expect((await stepped.completeAll(p, durable, { steps })).kind).toBe('linked');
  expect(durable.db.rows("SELECT key FROM native_import_stage_fact WHERE pass = 'plan'")).toHaveLength(16000);
  for (const s of steps) {
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
  const pair = await Promise.all([open(p, 'op-cap-a'), open(p, 'op-cap-b')]);
  expect(pair.filter(x => x.kind === 'progress')).toHaveLength(1);
  expect(pair.filter(x => x.kind === 'refused' && x.code === 'staging-quota')).toHaveLength(1);
  now += STAGED_SESSION_TTL_MS + 1;
  while ((await p.service.staged!.sweepExpired(p.token)).operationId !== null) {}
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
      if ((await resumed.service.staged!.sweepExpired(resumed.token)).operationId === null) break;
    }
    expect(stored()).toBeLessThanOrEqual(await ledger.held({ clientId: 'client-a' }));
    expect(stored()).toBeLessThanOrEqual(cap);
    // Allow any conservative writer/reclamation grace before the next repetition.
    now += STAGED_SESSION_TTL_MS + 1;
    while ((await resumed.service.staged!.sweepExpired(resumed.token)).operationId !== null) {}
    expect(await ledger.held({ clientId: 'client-a' })).toBe(0);
    expect(stored()).toBe(0);
  }
}, 120_000);
