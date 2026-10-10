// v5 spec: Payments & Net Claim (GRS-16, CC-06). The generic extraction never types an amount with separators, so
// this sweep records payments the way a user writes them (the app's own `R 1 000.00` shape, a comma group, plain
// decimals) through v5's form, then reads the three KPIs and the payments table (S-payments_tab-1: v5's net claim
// uses parseFloat while its table uses money()). Synthetic values only; the app adapter runs the same steps.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { domExtract } from '../../../lib/dom.mjs';
import { tableFromRaw } from '../../../lib/snapshot.mjs';

/** Typed amounts, all valid in the app's grammar; v5's parseFloat stops at the first space or comma. */
export const SEPARATED = ['1 000', 'R 500', '250.50', '1,000.25'];
const day = (clock, n) => new Date(Date.parse(clock) + n * 86400000).toISOString().slice(0, 10);
/** The synthetic payment for step i: date, amount, method, note. */
export const separatedPayment = (clock, i) => ({ date: day(clock, 1 + i), amount: SEPARATED[i], method: 'Synthetic method', note: `Synthetic separators ${i + 1}` });

/** The KPIs and the rows of the first table under #main, as the sweep records them (both sides). */
export function readPayments(raw) {
	const out = {};
	for (const k of raw.kpis) out[`kpi.${k.label}`] = [k.value, k.sub].filter(Boolean).join(' · ');
	const t = raw.tables[0] ? tableFromRaw(raw.tables[0]) : { columns: [], rows: [] };
	out.rows = String(t.rows.length);
	t.rows.forEach((r, i) => { out[`row.${i}`] = t.columns.map((c) => r[c.id]).join(' | '); });
	return out;
}

const separators = {
	id: 'separators',
	async v5(p, ctx) {
		await p.load({});
		await p.go('payments_tab');
		for (let i = 0; i < SEPARATED.length; i++) {
			const pay = separatedPayment(ctx.clock, i);
			await p.evaluate(`(() => { const v = ${JSON.stringify(pay)}; for (const [id, k] of [['pay_date', 'date'], ['pay_amount', 'amount'], ['pay_method', 'method'], ['pay_note', 'note']]) { const e = document.getElementById(id); e.value = v[k]; e.dispatchEvent(new Event('input', { bubbles: true })); } [...document.querySelectorAll('#main button')].find((b) => /^\\s*add\\b/i.test(b.textContent)).setAttribute('data-parity-add', '1'); })()`);
			await p.click('[data-parity-add]');
			await sleep(20);
		}
		return readPayments(await p.evaluate(`(${domExtract.toString()})('#main', {})`));
	},
};

export default { sweeps: [separators] };
