// App adapter: Advanced Search (GRS-14). The first state (no search yet), the export of the default search (every
// row, as v5), and v5's search_filters sweep through the app's form and Search button.
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { capture, refsThroughPages, openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { comboValues } from '../v5/specs/documents.mjs';
import { searchCombos } from '../v5/specs/search.mjs';
import { navFocus } from './_shell.mjs';

const VIEW = 'search';
const ID = { q: '#sq', bundle: '#sb', type: '#st', sender: '#ss', from: '#sf', to: '#sto', amin: '#samin', amax: '#samax', status: '#sst' };

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) s.exports.export_csv = (await capture(p, '#search-export', parseDownload, 15000))?.[0] ?? { name: '(nothing captured)' };
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async search_filters(p, ctx) {
			const out = {};
			for (const c of searchCombos(ctx.dims, ctx.clock)) {
				await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
				let refused = null;
				for (const [k, v] of Object.entries(c.f)) {
					if (k === 'bundle' || k === 'type' || k === 'status') { const r = await p.select(ID[k], v); if (r !== 'ok') { refused = r; break; } }
					else await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(ID[k])}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
				}
				if (refused) { out[`${c.key}.set`] = out[`${c.key}.order`] = refused; continue; }
				await p.click('#search-run');
				await p.waitFor(`document.getElementById('main').dataset.result !== 'idle' && !document.getElementById('main').dataset.busy`, 20000);
				if ((await p.evaluate(`document.getElementById('main').dataset.result`)) === 'invalid') { out[`${c.key}.set`] = out[`${c.key}.order`] = 'rejected'; continue; }
				const refs = await refsThroughPages(p, { pager: '#search-pager', rows: '#search-table tbody tr[data-ref]' });
				const total = /of ([\d,]+) results/.exec((await p.evaluate(`document.getElementById('search-count')?.textContent ?? ''`)) ?? '')?.[1] ?? null;
				Object.assign(out, comboValues(c.key, refs, total));
			}
			return out;
		},
	},
};
