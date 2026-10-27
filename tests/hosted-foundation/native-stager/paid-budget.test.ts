// The import and staging routes are composed for Workers Paid (ADR-0013). Limits read from Cloudflare's documentation on 27 October 2026:
//   https://developers.cloudflare.com/workers/platform/limits/  Subrequests per invocation: Free 50, Paid 10,000 (up to 10M by `limits.subrequests`).
//     "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1." A separate row,
//     "Subrequests to internal services", is 1,000 on Free and the configured limit (default 10,000) on Paid.
//   https://developers.cloudflare.com/d1/platform/limits/  Queries per Worker invocation: Free 50, Paid 1,000; a batch counts as one query.
import { describe, expect, it } from 'vitest';
import { nativeImportCost, overRequestBudget } from '../../../src/lib/results-review/native/budget.ts';
import { DEFAULT_STEP_BOUNDS, stepCost } from '../../../src/lib/results-review/native/staging/index.ts';
import { WORKERS_FREE_REQUEST, WORKERS_PAID_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';

const PAID = { subrequests: 10_000, d1Queries: 1_000 };
const ROWS = 100;

describe('the Workers Paid request budget', () => {
  it('stays under Cloudflare\'s documented Paid limits with headroom, and leaves Free\'s composition as it was', () => {
    expect(WORKERS_FREE_REQUEST).toEqual({ d1: 45, external: 45 });
    expect(WORKERS_PAID_REQUEST).toEqual({ d1: 900, external: 4500 });
    expect(WORKERS_PAID_REQUEST.d1).toBeLessThanOrEqual(PAID.d1Queries * 0.9);
    // Clerk fetches, D1 queries and R2 calls all count against subrequests; fetches are held to under half the limit so the rest is room for D1 and R2.
    expect(WORKERS_PAID_REQUEST.external + WORKERS_PAID_REQUEST.d1).toBeLessThanOrEqual(PAID.subrequests * 0.6);
  });

  it('admits a small one-request import Free refused, and still sends a v5-sized package to the staged route', () => {
    const small = { files: 12, originals: 1, rows: 40 };
    expect(overRequestBudget(small, { ...WORKERS_FREE_REQUEST, rowsPerBatch: ROWS })).toBeNull();
    const eight = { files: 12, originals: 8, rows: 200 };
    expect(overRequestBudget(eight, { ...WORKERS_FREE_REQUEST, rowsPerBatch: ROWS })).not.toBeNull();
    expect(overRequestBudget(eight, { ...WORKERS_PAID_REQUEST, rowsPerBatch: ROWS })).toBeNull();
    // 1,691 originals read in four passes is 6,764 D1 calls: far past 900, so one request cannot do it.
    const v5 = { files: 3050, originals: 1691, rows: 6500 };
    expect(nativeImportCost(v5, ROWS).d1).toBeGreaterThan(WORKERS_PAID_REQUEST.d1);
    expect(overRequestBudget(v5, { ...WORKERS_PAID_REQUEST, rowsPerBatch: ROWS })).toMatch(/one request here may make 900 and 4500/);
  });

  it('keeps the default step comfortably inside one Paid request, however many steps a request runs', () => {
    const cost = stepCost(DEFAULT_STEP_BOUNDS, ROWS);
    const steps = DEFAULT_STEP_BOUNDS.stepsPerRequest;
    expect(cost.d1 * steps).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.d1);
    expect(cost.external * steps).toBeLessThanOrEqual(WORKERS_PAID_REQUEST.external);
    expect((cost.d1 + cost.external + cost.r2) * steps).toBeLessThanOrEqual(PAID.subrequests * 0.8);
  });

  it('is what services.ts composes for the import routes', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../src/lib/server/runtime/hosted/services.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/requestBudget: WORKERS_PAID_REQUEST/);
    expect(source).not.toMatch(/WORKERS_FREE_REQUEST/);
  });
});
