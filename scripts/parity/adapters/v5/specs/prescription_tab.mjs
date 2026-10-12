// v5 spec: Prescription (GRS-16, CC-06). The generic extraction never filters, so three sweeps drive v5's controls:
// `filters` (text probes and every risk option, alone and combined), `stale` (filter, leave the view and come back:
// S-prescription_tab-1) and `export` (the CSV with and without a filter: S-prescription_tab-3, BA-17). Each records
// the shown rows across every page as a sequence digest, never row values. Text probes are generic (a digit, a ref
// prefix shape, a miss, white space), so no case wording appears in a key. The app adapter runs the same steps.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../../lib/exports.mjs';
import { seqValue } from '../../../lib/sweeps.mjs';

export const PROBES = ['', '1', 'OD-', 'zz-no-match', ' '];
/** The risk options as v5 offers them ('' is Any risk). */
export const RISKS = ['', 'Relies on interruption', 'Not yet due to prescribe'];
/** Index-coded combinations: every probe alone, every risk alone, and two probes with each risk. */
export const COMBOS = [
	...PROBES.map((_, q) => ({ q, r: 0 })),
	...RISKS.slice(1).map((_, i) => ({ q: 0, r: i + 1 })),
	...[1, 2].flatMap((q) => RISKS.slice(1).map((_, i) => ({ q, r: i + 1 }))),
].filter((c, i, a) => a.findIndex((x) => x.q === c.q && x.r === c.r) === i);
export const comboKey = (c) => `q${c.q}.r${c.r}`;

/**
 * Every ref shown for the current filter, page by page through the pager's Next button, with the page-1 pager text:
 * `{ rows: 'n|digest', pager }`. `table` and `pager` are the side's selectors.
 */
export async function readAll(p, { table, pager }) {
	const refs = [];
	let first = null;
	for (let i = 0; i < 100; i++) {
		const page = await p.evaluate(`(() => { const rows = [...document.querySelectorAll(${JSON.stringify(`${table} tbody tr`)})].map((r) => r.cells[0]?.textContent.trim() ?? ''); const pg = document.querySelector(${JSON.stringify(pager)}); const next = pg && [...pg.querySelectorAll('button')].find((b) => /next/i.test(b.textContent)); document.querySelectorAll('[data-parity-next]').forEach((e) => e.removeAttribute('data-parity-next')); if (next && !next.disabled) next.setAttribute('data-parity-next', '1'); return { rows, more: !!next && !next.disabled, text: pg ? pg.innerText.replace(/\\s+/g, ' ').trim() : '' }; })()`);
		first ??= page.text;
		refs.push(...page.rows);
		if (!page.more) return { rows: seqValue(refs), pager: first };
		await p.click('[data-parity-next]');
		await sleep(5);
	}
	throw new Error('prescription: more than 100 pages');
}

const V5 = { table: '#prescWrap table', pager: '#prescWrap .pager' };
const v5Filter = async (p, c) => {
	if (PROBES[c.q]) await p.type('#main input[placeholder="Filter invoice / ref"]', PROBES[c.q]);
	if (RISKS[c.r]) await p.select('#prrisk', RISKS[c.r]);
	await sleep(5);
};
const v5Controls = (p) => p.evaluate(`({ input: document.querySelector('#main input[placeholder="Filter invoice / ref"]').value, select: document.getElementById('prrisk').value })`);

const filters = {
	id: 'filters',
	async v5(p) {
		const out = {};
		for (const c of COMBOS) {
			await p.load({});
			await p.go('prescription_tab');
			await v5Filter(p, c);
			const r = await readAll(p, V5);
			out[`${comboKey(c)}.rows`] = r.rows;
			out[`${comboKey(c)}.pager`] = r.pager;
		}
		return out;
	},
};

/** Filter, open another view, return through the navigation: what the controls and the table show. */
export const STALE = { q: 1, r: 1 };
const stale = {
	id: 'stale',
	async v5(p) {
		await p.load({});
		await p.go('prescription_tab');
		await v5Filter(p, STALE);
		await p.click('#nav [data-tab="overview"]');
		await sleep(30);
		await p.click('#nav [data-tab="prescription_tab"]');
		await sleep(30);
		const ctl = await v5Controls(p);
		const r = await readAll(p, V5);
		return { input: ctl.input, select: ctl.select, rows: r.rows, pager: r.pager };
	},
};

/** The export's rows with no filter and with each of two filters, as a count and digest of refs (column 0). */
export const EXPORT_COMBOS = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 2 }];
export async function exportValue(p, press) {
	await p.takeDownloads();
	await press();
	await sleep(60);
	const d = (await p.takeDownloads())[0];
	if (!d) return { name: '(nothing captured)' };
	const e = await parseDownload(d);
	return { name: e.name, columns: (e.columns ?? []).join(' | '), rows: seqValue((e.rows ?? []).map((r) => r[0])) };
}
const exporting = {
	id: 'export',
	async v5(p) {
		const out = {};
		for (const c of EXPORT_COMBOS) {
			await p.load({});
			await p.go('prescription_tab');
			await v5Filter(p, c);
			const e = await exportValue(p, async () => { await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => /export csv/i.test(b.textContent)).setAttribute('data-parity-export', '1')`); await p.click('[data-parity-export]'); });
			for (const [k, v] of Object.entries(e)) if (k !== 'name') out[`${comboKey(c)}.${k}`] = v;
		}
		return out;
	},
};

export default { sweeps: [filters, stale, exporting] };
