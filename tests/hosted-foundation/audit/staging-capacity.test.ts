// GRS-270: staging's protected audit budget was 10,000 events, and one RC rehearsal day (ten journeys, mostly case.read
// and case.read-original authority events) wrote exactly 10,000. Every protected action then refused as
// audit-unavailable, which the views show as "the store is busy", and the Worker logged nothing.
// node:sqlite stand-in for the log line: unit evidence only, not D1 evidence.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditConfig } from '../../../src/lib/audit/index.ts';
import { event, world } from './world.ts';

const REHEARSAL_DAY_EVENTS = 10_000; // measured on staging D1, 28 Oct, one rehearsal of the ten journeys
const ROW_BYTES = 1024; // a stored event averaged about 650 bytes of row data; 1 KiB allows for its indexes
const D1_DATABASE_BYTES = 10 * 1000 ** 3; // the Workers Paid per-database limit

function stagingAuditLimits() {
  const text = readFileSync(new URL('../../../deploy/staging/wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(JSON.parse(text).vars.CLEARCASE_NATIVE_CONFIG).auditLimits;
}

describe('staging audit capacity', () => {
  it('holds at least a hundred rehearsal days of protected events and still fits half a D1 database', () => {
    const limits = stagingAuditLimits();
    expect(auditConfig({ clientId: 'staging', trustedIssuers: ['https://clerk.staging.example'], limits }).limits).toEqual(limits);
    expect(limits.maxRows).toBeGreaterThanOrEqual(100 * REHEARSAL_DAY_EVENTS);
    expect(limits.maxRows * ROW_BYTES).toBeLessThanOrEqual(D1_DATABASE_BYTES / 2);
  });
});

describe('a spent protected budget', () => {
  afterEach(() => vi.restoreAllMocks());
  it('names itself in the Worker log, with the class and no event content, and stays non-retryable', async () => {
    const w = world({ over: { maxRows: 2 } }); await w.ready;
    await w.log().append(event()); await w.log().append(event());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = event();
    await expect(w.log().append(refused)).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    expect(logged.mock.calls).toEqual([['audit-capacity-exhausted', { class: 'protected', limit: 2 }]]);
  });
  it('logs nothing while the budget has room', async () => {
    const w = world({ over: { maxRows: 2 } }); await w.ready;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.log().append(event()); await w.log().append(event());
    expect(logged).not.toHaveBeenCalled();
  });
});
