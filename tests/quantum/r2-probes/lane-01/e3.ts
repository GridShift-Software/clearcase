// @ts-nocheck -- a verification lane's synthetic probe, copied unchanged below these two lines (CC-06 r2)
export {};
const root = process.argv[2];
const io = await import(`${root}/src/lib/views/quantum/interest.ts`);
const sh = (s: string) => BigInt(s.replace(/[^0-9]/g, '')) * (s.startsWith('-') ? -1n : 1n);
let n = 0, broken: unknown[] = [];
for (let i = 0; i < 20000; i++) {
	const p = String(Math.floor(Math.random() * 1e13)) + '.' + String(Math.floor(Math.random() * 100)).padStart(2, '0');
	const r = (Math.random() * 40).toFixed(2);
	const to = `${2030 + Math.floor(Math.random() * 60)}-06-15`;
	for (const m of ['Simple', 'Compound (monthly)']) {
		let o; try { o = io.interestOutcome({ p, r, m, from: '2081-01-01', to }, null); } catch { continue; }
		if (!o.kpis) continue; n++;
		const [c, it, t] = o.kpis.map((x) => sh(x.value));
		if (c! + it! !== t!) broken.push({ p, r, m, to, shown: o.kpis.slice(0, 3).map((x) => x.value) });
	}
}
console.log(JSON.stringify({ checked: n, broken: broken.length, first: broken.slice(0, 2) }, null, 1));
