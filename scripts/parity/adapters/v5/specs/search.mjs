// v5 spec: Advanced Search (GRS-14). search_filters: generic probes through the form and the Search button, every shown
// ref across every page (as a set and as a sequence) and the result total. Bundles, types and statuses are
// index-coded over the package's sorted options; dates are the run clock's day and fixed far-past days; amounts are
// small round numbers. No case value appears in a key or an input. A bundle v5 offers no option for reads 'no-option'.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { comboValues } from './documents.mjs';

const PAST = '1900-01-01', PAST2 = '1900-01-02';
const SENDERS = ['e', '.', 'zqzqzq'];

/** The search combinations: field values by form field id (q, bundle, type, sender, from, to, amin, amax, status). */
export function searchCombos(dims, clock) {
	const today = clock.slice(0, 10);
	const out = [{ key: 'all', f: {} }];
	dims.queries.forEach((q, i) => { if (i) out.push({ key: `q${i}`, f: { q } }); });
	dims.bundles.forEach((bundle, i) => { if (i) out.push({ key: `b${i}`, f: { bundle } }); });
	dims.types.forEach((type, i) => { if (i) out.push({ key: `t${i}`, f: { type } }); });
	dims.statuses.forEach((status, i) => { if (i) out.push({ key: `s${i}`, f: { status } }); });
	SENDERS.forEach((sender, i) => out.push({ key: `p${i}`, f: { sender } }));
	out.push({ key: 'd1', f: { from: PAST } }, { key: 'd2', f: { to: today } }, { key: 'd3', f: { from: today, to: PAST } }, { key: 'd4', f: { from: PAST, to: PAST2 } });
	out.push({ key: 'm1', f: { amin: '0' } }, { key: 'm2', f: { amax: '1000' } }, { key: 'm3', f: { amin: '1000', amax: '0' } }, { key: 'm4', f: { amin: 'abc' } }, { key: 'm5', f: { amin: '0', amax: '0.5' } });
	dims.bundles.forEach((bundle, i) => { if (i) out.push({ key: `b${i}.q2`, f: { bundle, q: dims.queries[2] } }); });
	return out;
}

const V5_ID = { q: '#sq', bundle: '#sb', type: '#st', sender: '#ss', from: '#sf', to: '#sto', amin: '#samin', amax: '#samax', status: '#sst' };

async function v5Refs(p) {
	const refs = [];
	let total = null;
	for (let i = 0; i < 400; i++) {
		const page = await p.evaluate(`(() => { const rows = [...document.querySelectorAll('#searchRes tbody tr')].map((r) => r.cells[1]?.textContent ?? ''); const next = [...document.querySelectorAll('#searchRes .pager button')].find((b) => /next/i.test(b.textContent)); if (next && !next.disabled) next.setAttribute('data-parity-next', '1'); return { rows, more: !!next && !next.disabled, total: (/of ([\\d,]+) results/.exec(document.querySelector('#searchRes .count')?.textContent ?? '') ?? [])[1] ?? null }; })()`);
		refs.push(...page.rows);
		total ??= page.total;
		if (!page.more) return { refs, total };
		await p.click('[data-parity-next]');
		await sleep(2);
	}
	throw new Error('v5 search: more than 400 pages');
}

export default {
	sweeps: [{
		id: 'search_filters',
		async v5(p, ctx) {
			const out = {};
			for (const c of searchCombos(ctx.dims, ctx.clock)) {
				await p.load({});
				await p.go('search');
				let refused = null;
				for (const [k, v] of Object.entries(c.f)) {
					if (k === 'bundle' || k === 'type' || k === 'status') { const r = await p.select(V5_ID[k], v); if (r !== 'ok') { refused = r; break; } }
					else await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(V5_ID[k])}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
				}
				if (refused) { out[`${c.key}.set`] = out[`${c.key}.order`] = refused; continue; }
				await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === 'Search')?.setAttribute('data-parity-search', '1')`);
				await p.click('[data-parity-search]');
				await sleep(5);
				const { refs, total } = await v5Refs(p);
				Object.assign(out, comboValues(c.key, refs, total));
			}
			return out;
		},
	}],
};
