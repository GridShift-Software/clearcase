// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
const root = process.argv[2];
const money = await import(`${root}/src/lib/calculations/money.ts`);
const pay = await import(`${root}/src/lib/views/quantum/payments.ts`);
const st = await import(`${root}/src/lib/views/quantum/settlement.ts`);
for (const claim of ['100.4950', '100.4999', '100.50', '2.4950']) {
	const t = pay.totals(money.importedUnits(claim)!, []);
	console.log(claim, 'app prefill', st.claimPrefill(t.net), '| v5 toFixed(0)', parseFloat(claim).toFixed(0), '| exact half-up of claim', String(money.divRound(money.importedUnits(claim)!, 10000n)));
}
