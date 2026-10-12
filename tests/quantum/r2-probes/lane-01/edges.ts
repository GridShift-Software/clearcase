// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
const root = process.argv[2];
const money = await import(`${root}/src/lib/calculations/money.ts`);
const dates = await import(`${root}/src/lib/calculations/dates.ts`);
const interest = await import(`${root}/src/lib/calculations/interest.ts`);
const pay = await import(`${root}/src/lib/views/quantum/payments.ts`);
const st = await import(`${root}/src/lib/views/quantum/settlement.ts`);
const io = await import(`${root}/src/lib/views/quantum/interest.ts`);
const { fmtR } = await import(`${root}/src/lib/components/format.ts`);
const out: Record<string, unknown> = {};
const tryIt = (f: () => unknown) => { try { return f(); } catch (e) { return `THROWS ${(e as Error).name}: ${(e as Error).message}`; } };
// E1: years below 100 (Date.UTC maps 0-99 to 1900-1999)
out.E1_days_0099_to_0100 = dates.daysBetween('0099-12-31', '0100-01-01');
out.E1_days_0050_to_0051 = dates.daysBetween('0050-01-01', '0051-01-01');
out.E1_days_0050_to_2026 = dates.daysBetween('0050-01-01', '2026-01-01');
out.E1_interest_0099_0100 = tryIt(() => io.interestOutcome({ p: '1000', r: '10', m: 'Simple', from: '0099-12-31', to: '0100-01-01' }, null));
// E2: compound overflow beyond 1e21 and to Infinity
out.E2_compound_big = tryIt(() => io.interestOutcome({ p: '1000000', r: '100', m: 'Compound (monthly)', from: '1950-01-01', to: '2026-01-01' }, null));
out.E2_compound_inf = tryIt(() => io.interestOutcome({ p: '1000', r: '999999999', m: 'Compound (monthly)', from: '1950-01-01', to: '2026-01-01' }, null));
// E3: large totals formatted by fmtR (Capital + Interest = Total on screen)
const k = io.interestOutcome({ p: '9 999 999 999 999.99', r: '10', m: 'Simple', from: '2000-01-01', to: '2040-01-01' }, null).kpis;
out.E3_simple_large = k?.slice(0, 3).map((x) => x.value);
const sh = (s: string) => BigInt(s.replace(/[^0-9]/g, '')) * (s.startsWith('-') ? -1n : 1n);
if (k) out.E3_identity_on_screen = sh(k[0]!.value) + sh(k[1]!.value) === sh(k[2]!.value);
// E4: net = gross - paid as shown, with a 4-dp claim and an overpayment
const rows = [{ rowId: 'a', seq: 1, date: '', amount: '200', amountCents: 20000n, method: '', note: '' }];
const t = pay.totals(money.importedUnits('100.0050')!, rows);
out.E4_totals = { gross: String(t.gross), paid: String(t.paid), net: String(t.net), grossMinusPaid: String(t.gross - t.paid) };
// E5: negative net claim -> settlement prefill and default outcome
const pre = st.claimPrefill(-110075n);
out.E5_prefill = pre;
out.E5_settle_default = st.settleOutcome(st.defaultInputs(pre, { probability: 60, years: 3, discount: 8, cost: 1000 }));
out.E5_prefill_zero = st.claimPrefill(0n);
// E6: as-of date near midnight in another zone
out.E6_utcDate = [dates.utcDate(new Date('2026-10-08T23:30:00Z')), dates.utcDate(new Date('2026-10-09T00:30:00+02:00'))];
// E7: 13-digit cap and grammar sanity
out.E7_parse = Object.fromEntries(['R 1 000.00', 'R1,000', '1 000,50', '-5', 'R -5', '1,000.5', '1.005', '9 999 999 999 999.99', '10 000 000 000 000', ' 12 ', '1 0000', 'R  100', '١٢٣'].map((s) => { const r = money.parseAmount(s); return [s, r.ok ? String(r.value) : r.error]; }));
console.log(JSON.stringify(out, null, 1));
