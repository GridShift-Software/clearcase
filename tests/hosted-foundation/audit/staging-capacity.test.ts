// GRS-270: staging's protected audit budget was 10,000 events, and one RC rehearsal day (ten journeys, mostly case.read
// and case.read-original authority events) wrote exactly 10,000. Every protected action then refused as
// audit-unavailable, which the views show as "the store is busy", and the Worker logged nothing.
// node:sqlite stand-in for the log line: unit evidence only, not D1 evidence.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditConfig } from '../../../src/lib/audit/index.ts';
import { admin, event, gate, viewer, world } from './world.ts';

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
  it('keeps the same refusal when the Worker log itself throws', async () => {
    const w = world({ over: { maxRows: 1 } }); await w.ready;
    await w.log().append(event());
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('log sink down'); });
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
  });
  it('does not log a failed insert while the budget has room: that refusal stays retryable', async () => {
    const w = world({ over: { maxRows: 2 } }); await w.ready;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    w.fault.failInsert = true;
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('the other audit classes', () => {
  afterEach(() => vi.restoreAllMocks());
  const ask = { scope: { kind: 'case' as const, caseId: 'case-a1' as never }, cursor: null, limit: 10 };
  it('a spent read budget names itself with the read limit', async () => {
    const w = world({ over: { maxReadRows: 1 } }); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] } });
    await w.log(viewer, g).query(ask);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(w.log(viewer, g).query(ask)).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    expect(logged.mock.calls).toEqual([['audit-capacity-exhausted', { class: 'read', limit: 1 }]]);
  });
  it('a denial past its bound is the designed outcome and logs nothing', async () => {
    const w = world({ over: { maxDenialRows: 1, maxDenialsPerActor: 1 } }); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] } });
    await expect(w.log(admin, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(w.log(admin, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    expect(logged).not.toHaveBeenCalled();
  });
});
