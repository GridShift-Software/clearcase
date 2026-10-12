// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
// exact simple interest vs what the page shows, for large synthetic inputs
const W = process.argv[2];
const { interestOutcome } = await import(`${W}/src/lib/views/quantum/interest.ts`);
const { totals } = await import(`${W}/src/lib/views/quantum/payments.ts`);
const { fmtR } = await import(`${W}/src/lib/components/format.ts`);
const { centsText } = await import(`${W}/src/lib/calculations/money.ts`);
const exactR = (c: bigint) => { const s = centsText(c); const [i, d] = s.split('.'); return `R ${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${d}`; };
const divRound = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
const P = 999999999999999n; // cents
const exactInterest = divRound(P * 1000n * 365n * 4n, 1n * 100n * 1461n);
const out = interestOutcome({ p: '9999999999999.99', r: '1000', m: 'Simple', from: '2025-01-01', to: '2026-01-01' }, 0n);
console.log('interest shown ', out.kpis![1]!.value, ' exact', exactR(exactInterest), out.kpis![1]!.value === exactR(exactInterest) ? 'MATCH' : 'MISMATCH');
console.log('total shown    ', out.kpis![2]!.value, ' exact', exactR(exactInterest + P), out.kpis![2]!.value === exactR(exactInterest + P) ? 'MATCH' : 'MISMATCH');
// find a mismatch with a modest rate: R 9 999 999 999 999.99 at 100% over N years
for (const [r, from, to] of [['100', '2081-01-01', '2089-01-01'], ['200', '2081-01-01', '2085-01-01'], ['10', '1950-01-01', '2026-01-01'], ['25', '1990-01-01', '2026-01-01']] as const) {
	const o = interestOutcome({ p: '9999999999999.99', r, m: 'Simple', from, to }, 0n);
	const days = (Date.UTC(+to.slice(0, 4), 0, 1) - Date.UTC(+from.slice(0, 4), 0, 1)) / 864e5;
	const ex = divRound(P * BigInt(r) * BigInt(days) * 4n, 100n * 1461n);
	console.log(`r=${r} ${from}..${to}`, 'interest', o.kpis![1]!.value, o.kpis![1]!.value === exactR(ex) ? 'MATCH' : `MISMATCH exact ${exactR(ex)}`, '| total', o.kpis![2]!.value, o.kpis![2]!.value === exactR(ex + P) ? 'MATCH' : `MISMATCH exact ${exactR(ex + P)}`);
}
// payments: 8 synthetic payments of R 9 999 999 999 999.99 against a gross of R 1 000.00
const rows = Array.from({ length: 8 }, (_, i) => ({ rowId: `r${i}`, seq: i + 1, date: '2081-01-01', amount: '9999999999999.99', amountCents: 999999999999999n, method: '', note: '' }));
const t = totals(10000000n, rows);
console.log('paid shown', fmtR(centsText(t.paid)), 'exact', exactR(t.paid), fmtR(centsText(t.paid)) === exactR(t.paid) ? 'MATCH' : 'MISMATCH');
console.log('net shown ', fmtR(centsText(t.net)), 'exact', exactR(t.net), fmtR(centsText(t.net)) === exactR(t.net) ? 'MATCH' : 'MISMATCH');
