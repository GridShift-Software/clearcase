// App adapter: Documents (GRS-14). The default bundle's rows, every page through the Next button, with v5's pager
// wording and total; the bundle buttons and filter as controls.
import { fromRaw } from '../../lib/snapshot.mjs';
import { pageThroughApp, pagerText } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { bundleFilterCombos, comboValues } from '../v5/specs/documents.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'documents';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const raw = await p.extract('#main');
		const pager = await pagerText(p, '#documents-pager');
		await pageThroughApp(p, { pager: '#documents-pager', table: '#documents-table', rows: raw.tables[0].rows });
		const s = fromRaw(VIEW, 'app', raw);
		s.texts['table_1.pager'] = pager;
		const m = /of ([\d,\s]+)\s*$/.exec(pager ?? '');
		if (m) s.counts['table_1.total'] = m[1].trim();
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		/** v5's bundle_filter through the app's bundle buttons and filter field: every shown ref on every page. */
		async bundle_filter(p, ctx) {
			const out = {};
			for (const c of bundleFilterCombos(ctx.dims)) {
				await open(p, ctx, ctx.registry[VIEW].route, VIEW);
				const ok = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main .toolbar button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(`${c.bundle} (`)})); if (!b) return false; b.setAttribute('data-parity-bundle', '1'); return true; })()`);
				if (!ok) { out[`${c.key}.set`] = out[`${c.key}.order`] = 'no-option'; continue; }
				await p.click('[data-parity-bundle]');
				await p.waitFor(`document.getElementById('main').dataset.bundle === ${JSON.stringify(c.bundle)} && !document.getElementById('main').dataset.busy`, 20000);
				if (c.query) {
					await p.type('#doc-filter', c.query);
					await p.waitFor(`document.getElementById('main').dataset.q === ${JSON.stringify(c.query)} && !document.getElementById('main').dataset.busy`, 20000);
				}
				const refs = await p.evaluate(`[...document.querySelectorAll('#documents-table tbody tr[data-ref]')].map((r) => r.dataset.ref)`);
				const rest = [];
				await pageThroughApp(p, { pager: '#documents-pager', table: '#documents-table', rows: rest });
				refs.push(...rest.map((cells) => (cells[0] ?? []).join(' ')));
				const total = /of ([\d,]+)/.exec((await pagerText(p, '#documents-pager')) ?? '')?.[1] ?? null;
				Object.assign(out, comboValues(c.key, refs, total));
			}
			return out;
		},
	},
};
