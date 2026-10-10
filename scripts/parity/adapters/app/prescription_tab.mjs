// App adapter: Prescription (GRS-16, CC-06). The page keeps v5's layout (KPI cards, the imported note, the filter
// row, the paged table with v5's pager wording); the shared extractor reads page 1 and the adapter pages through with
// Next, as the v5 adapter does, appending every page's rows. The sweeps run the v5 spec's filter, stale-filter and
// export steps through the app's own controls.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { COMBOS, comboKey, EXPORT_COMBOS, exportValue, PROBES, readAll, RISKS, STALE } from '../v5/specs/prescription_tab.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

const VIEW = 'prescription_tab';
const APP = { table: '#prescription', pager: '#pr-pager' };
const route = (ctx) => ctx.registry[VIEW].route;

async function filter(p, c) {
	if (PROBES[c.q]) await p.type('#pr-q', PROBES[c.q]);
	if (RISKS[c.r]) await p.select('#pr-risk', RISKS[c.r]);
	await sleep(5);
	await p.settled();
}

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, route(ctx), VIEW);
		const raw = await p.extract('#main');
		// every page through Next, appended to the page-1 table (the v5 adapter's pageThrough)
		const at = await p.evaluate(`[...document.querySelectorAll('#main table, #main [role=table]')].filter((x) => x.getClientRects().length).indexOf(document.getElementById('prescription'))`);
		const pager = await p.evaluate(`document.getElementById('pr-pager').innerText.replace(/\\s+/g, ' ').trim()`);
		for (let i = 0; i < 100; i++) {
			const more = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#pr-pager button')].find((b) => /next/i.test(b.textContent)); if (!b || b.disabled) return false; b.setAttribute('data-parity-next', '1'); return true; })()`);
			if (!more) break;
			await p.click('[data-parity-next]');
			await sleep(5);
			await p.settled();
			raw.tables[at].rows.push(...(await p.extract('#prescription')).tables[0].rows);
		}
		const s = fromRaw(VIEW, 'app', raw);
		const id = Object.keys(s.tables)[at];
		s.texts[`${id}.pager`] = pager;
		const m = /of ([\d,\s]+)\s*$/.exec(pager);
		if (m) s.counts[`${id}.total`] = m[1].trim();
		if (ctx.exports) {
			await open(p, ctx, route(ctx), VIEW);
			const got = await pressAndCapture(p, '#export-presc', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async filters(p, ctx) {
			const out = {};
			for (const c of COMBOS) {
				await open(p, ctx, route(ctx), VIEW);
				await filter(p, c);
				const r = await readAll(p, APP);
				out[`${comboKey(c)}.rows`] = r.rows;
				out[`${comboKey(c)}.pager`] = r.pager;
			}
			return out;
		},
		async stale(p, ctx) {
			await open(p, ctx, route(ctx), VIEW);
			await filter(p, STALE);
			await p.click('#nav-overview');
			await p.waitFor(`!!document.querySelector('[data-ready="overview"]')`, 30000);
			await p.click(`#nav-${VIEW}`);
			await p.waitFor(`!!document.querySelector('[data-ready="${VIEW}"]')`, 30000);
			await p.settled();
			const ctl = await p.evaluate(`({ input: document.getElementById('pr-q').value, select: document.getElementById('pr-risk').value })`);
			const r = await readAll(p, APP);
			return { input: ctl.input, select: ctl.select, rows: r.rows, pager: r.pager };
		},
		async export(p, ctx) {
			const out = {};
			for (const c of EXPORT_COMBOS) {
				await open(p, ctx, route(ctx), VIEW);
				await filter(p, c);
				const e = await exportValue(p, () => p.click('#export-presc'));
				for (const [k, v] of Object.entries(e)) if (k !== 'name') out[`${comboKey(c)}.${k}`] = v;
			}
			return out;
		},
	},
};
