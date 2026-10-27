// U15 fix round 1 (M1): what one `complete` request may call is bounded by construction, its steps and its link together, and checked
// against the plan's whole per-request allowance (D1 queries, and every subrequest: D1, R2 and the identity provider) before a step runs.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_STEP_BOUNDS, stagedCompleteCost } from '../../../src/lib/results-review/native/staging/index.ts';
import { WORKERS_PAID_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';
import * as stepped from './stepped-world.ts';

describe('the cost of one complete request', () => {
  it('fits Workers Paid: at most 1,000 D1 queries and 10,000 subrequests of every kind, with the default bounds', () => {
    const c = stagedCompleteCost(DEFAULT_STEP_BOUNDS, 100);
    expect(WORKERS_PAID_REQUEST.d1).toBeLessThanOrEqual(1000);
    expect(WORKERS_PAID_REQUEST.subrequests).toBeLessThanOrEqual(10_000);
    expect(c.d1).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.d1);
    expect(c.external).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.external);
    expect(c.d1 + c.r2 + c.external).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.subrequests!);
  });

  let pkg: stepped.RealPackage;
  beforeAll(async () => { pkg = await stepped.realPackage(); }, 600_000);

  for (const stepsPerRequest of [1, 3]) {
    it(`holds every request of a stepped import to it, the linking one included (${stepsPerRequest} step(s) a request)`, async () => {
      const { durable, revisionId } = await stepped.uploaded(pkg);
      const p = await stepped.startProcess(durable, { bounds: { stepsPerRequest } });
      const steps: stepped.StepRecord[] = [];
      expect((await stepped.driveStaged(p, durable, pkg, revisionId, { steps })).kind).toBe('linked');
      const c = stagedCompleteCost(p.bounds, stepped.BIG_BUDGETS.maxRowsPerBatch);
      expect(steps.length).toBeGreaterThan(1);
      for (const s of steps) {
        expect(s.d1).toBeLessThanOrEqual(c.d1);
        expect(s.r2Gets + s.puts + s.heads).toBeLessThanOrEqual(c.r2);
      }
    }, 600_000);
  }

  it('refuses before any step when the steps and the link would make more subrequests than the plan allows, R2 included', async () => {
    const { durable, revisionId } = await stepped.uploaded(pkg);
    const c = stagedCompleteCost(stepped.TEST_BOUNDS, stepped.BIG_BUDGETS.maxRowsPerBatch);
    // Room for every D1 query and identity check, and for all of them together, but not for the R2 calls as well.
    const p = await stepped.startProcess(durable, { requestBudget: { d1: c.d1, external: c.external, subrequests: c.d1 + c.external + c.r2 - 1, rowsPerBatch: stepped.BIG_BUDGETS.maxRowsPerBatch } });
    const out = await stepped.driveStaged(p, durable, pkg, revisionId).catch((e) => e);
    expect(out).toMatchObject({ kind: 'refused', code: 'over-budget' });
    expect(durable.db.rows('SELECT 1 FROM native_import_stage_run')).toHaveLength(0);
    const fits = await stepped.startProcess(durable, { requestBudget: { d1: c.d1, external: c.external, subrequests: c.d1 + c.external + c.r2, rowsPerBatch: stepped.BIG_BUDGETS.maxRowsPerBatch } });
    expect((await stepped.completeAll(fits, durable)).kind).toBe('linked');
  }, 600_000);
});
