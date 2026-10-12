// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
// Lane 03 probe: hostile synthetic inputs through the CC-06 pure functions. Synthetic data only.
const W = process.argv[2];
const { parseAmount, parseDecimal, floatToCents, centsText } = await import(`${W}/src/lib/calculations/money.ts`);
const { daysBetween, ymd } = await import(`${W}/src/lib/calculations/dates.ts`);
const { interestOutcome, queryInputs } = await import(`${W}/src/lib/views/quantum/interest.ts`);
const { settleOutcome, settleInputs, defaultInputs } = await import(`${W}/src/lib/views/quantum/settlement.ts`);
const { fmtR } = await import(`${W}/src/lib/components/format.ts`);
const show = (label: string, v: unknown) => console.log(label.padEnd(44), JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)));
console.log('--- parseAmount');
for (const t of ['9999999999999.99', '99999999999999', '10000000000000', '0000000000000001000', '1e5', 'NaN', 'Infinity', '-5', 'R -5', '−5', '1 000,50', '1000,5', '1 000', '1 000', '１０００', '1,000', '1,000.005', ' R 1 000.00 ', ' 1000 ', 'R1 000,000', '0x10', '1_000', fmtR('1234567.50')])
	{ const r = parseAmount(t); show(JSON.stringify(t), r.ok ? `ok ${centsText(r.value)}` : `ERR ${r.error}`); }
console.log('--- parseDecimal');
for (const t of ['150', '100.5', '999999999', '1e3', 'NaN', 'Infinity', '-1', '0010', '10,5', '1 0', '５０'])
	{ const r = parseDecimal(t, 'a probability'); show(JSON.stringify(t), r.ok ? `ok ${r.value.value}` : `ERR ${r.error}`); }
console.log('--- dates');
for (const [a, b] of [['2026-02-30', '2026-03-01'], ['0000-01-01', '0001-01-01'], ['0000-02-29', '0000-03-01'], ['0050-01-01', '0100-01-01'], ['0099-12-31', '0100-01-01'], ['0001-01-01', '2001-01-01'], ['1901-01-01', '2001-01-01'], ['9999-12-31', '9999-12-31'], ['2024-01-01', '2023-01-01']])
	show(`${a} -> ${b}`, { days: daysBetween(a!, b!), ymdA: ymd(a!) });
// true proleptic Gregorian day counts, for comparison: 0000-01-01..0001-01-01 = 366; 0050..0100 = 18262; 0099-12-31..0100-01-01 = 1; 0001..2001 = 730485; 1901..2001 = 36524
const base = { p: '1000', r: '10', m: 'Simple', from: '2025-01-01', to: '2026-01-01' };
const ic = (o: Partial<typeof base>) => { try { const out = interestOutcome({ ...base, ...o }, 115000000n); return out.kpis ? out.kpis.map((k) => `${k.label}=${k.value}|${k.sub}`) : out.errors; } catch (e) { return `THROWS ${(e as Error).name}: ${(e as Error).message}`; } };
console.log('--- interest');
show('baseline', ic({}));
show('from 0000-01-01 to 0001-01-01', ic({ from: '0000-01-01', to: '0001-01-01' }));
show('from 0099-12-31 to 0100-01-01', ic({ from: '0099-12-31', to: '0100-01-01' }));
show('from 0024-03-01 to 2026-03-01', ic({ from: '0024-03-01', to: '2026-03-01' }));
show('to 9999 simple r=999999999 p=13dig', ic({ p: '9999999999999.99', r: '999999999', from: '0001-01-01', to: '9999-12-31' }));
show('simple p=13dig r=1000 1y', ic({ p: '9999999999999.99', r: '1000', from: '2025-01-01', to: '2026-01-01' }));
show('compound r=10 0001..9999', ic({ m: 'Compound (monthly)', from: '0001-01-01', to: '9999-12-31' }));
show('compound r=50 p=1 2000..2100', ic({ p: '1', r: '50', m: 'Compound (monthly)', from: '2000-01-01', to: '2100-01-01' }));
show('compound r=999999999 1y', ic({ m: 'Compound (monthly)', r: '999999999' }));
show('m=bogus', ic({ m: 'Bogus' }));
show('reversed', ic({ from: '2026-01-01', to: '2025-01-01' }));
show('repeated params', queryInputs(new URLSearchParams('p=1&p=2&r=10&r=99'), { rate: 10, from: '2025-01-01', to: '2026-01-01' }));
console.log('--- settlement');
const sdef = defaultInputs('1150', { probability: 60, years: 2, discount: 10, cost: 50000 });
const so = (q: string) => { try { const o = settleOutcome(settleInputs(new URLSearchParams(q), sdef)); return o.kpis ? [...o.kpis.map((k) => `${k.label}=${k.value}`), o.floor?.slice(0, 120)] : o.errors; } catch (e) { return `THROWS ${(e as Error).name}: ${(e as Error).message}`; } };
show('defaults', so(''));
show('p=150', so('p=150&c=0'));
show('p=999999999 claim=13dig', so('p=999999999&claim=9999999999999.99&c=0'));
show('y=999999999 d=10', so('y=999999999&d=10&c=0'));
show('y=999999999 d=0', so('y=999999999&d=0&c=0'));
show('p=NaN', so('p=NaN'));
show('y=Infinity', so('y=Infinity'));
show('p=1e2', so('p=1e2'));
show('claim=-1', so('claim=-1'));
show('p=0 (cost 50000)', so('p=0'));
console.log('--- fmtR on exact cents strings (2^46..)');
for (const s of ['70368744177664.01', '99999999999999.99', '140737488355328.03', '999999999999999.99', '1000000000000000000000.00', '123456789012345678901234.56']) show(s, fmtR(s));
