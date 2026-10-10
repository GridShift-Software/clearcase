// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
// Synthetic edge probes against the CC-06 pure modules (no case data).
const W = '/home/vaper/Work/Active/MX-two/ClearCase/worktrees/verify-CC-06-02/src/lib';
const { totals } = await import(`${W}/views/quantum/payments.ts`);
const { claimPrefill, settleOutcome } = await import(`${W}/views/quantum/settlement.ts`);
const { importedUnits, parseAmount } = await import(`${W}/calculations/money.ts`);
const { utcDate } = await import(`${W}/calculations/dates.ts`);
const { asOfStatus } = await import(`${W}/views/quantum/prescription.ts`);
// E1: recorded payments exceed the imported gross claim -> the settlement prefill is the app's own negative net
const t = totals(importedUnits('1150.00')!, [{ rowId: 'a', seq: 1, date: '', amount: '2000', amountCents: 200000n, method: '', note: '' }]);
const prefill = claimPrefill(t.net);
const out = settleOutcome({ claim: prefill, p: '70', y: '2', d: '10', c: '100000' });
console.log('E1 net cents', String(t.net), 'prefill', JSON.stringify(prefill), 'errors', JSON.stringify(out.errors), 'kpis', out.kpis);
// E2: as-of date is the UTC calendar date; at 23:30Z on 8 Oct it is already 9 Oct in South Africa (UTC+2)
const at = new Date('2026-10-08T23:30:00Z');
const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(at);
const row = { no: 'S1', ref: 'OD-1', date: '2023-10-09', prescDate: '2026-10-09', risk: 'Not yet due to prescribe', url: '' };
console.log('E2 asOf(UTC)', utcDate(at), 'local date', local, 'status', asOfStatus(row, utcDate(at)));
// E3: "0,500" (comma decimal with three digits) is read as 500 rand, not refused as ambiguous
const z = parseAmount('0,500'); console.log('E3 0,500 ->', z.ok ? String(z.value) + ' cents' : z.error);
