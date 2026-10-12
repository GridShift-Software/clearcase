// App adapter: Filings & Affidavits (GRS-14). v5 shows each filing group as a card whose header and note are plain
// text under the page's "Orientation" heading, so its snapshot ids are orientation.N (texts) and orientation,
// orientation_2, … (tables). The app gives each group its own heading; this adapter reads the group headers and notes
// from the page and files them, in page order, under v5's ids. The register sweep is v5's register_edit.
import { parseDownload } from '../../lib/exports.mjs';
import { slug } from '../../lib/normalize.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { capture, registerEdit, openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { navFocus, readOverviewTiles } from './_shell.mjs';

const VIEW = 'filings_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		const groups = await p.evaluate(`[...document.querySelectorAll('#main section.group')].map((g) => ({ head: g.querySelector('h2').textContent.replace(/\\s+/g, ' ').trim(), note: g.querySelector('.group-note')?.textContent.replace(/\\s+/g, ' ').trim() ?? null }))`);
		if (s.texts['orientation.1'] !== undefined) {
			// v5 order: the orientation paragraph, then per group its header and its note
			let k = 2;
			const tables = {};
			for (const [id, t] of Object.entries(s.tables)) tables[id] = t;
			groups.forEach((g, i) => {
				const own = slug(g.head);
				s.texts[`orientation.${k++}`] = g.head;
				if (g.note !== null) { s.texts[`orientation.${k++}`] = g.note; delete s.texts[`${own}.1`]; }
				const to = i === 0 ? 'orientation' : `orientation_${i + 1}`;
				if (tables[own] && own !== to) { s.tables[to] = tables[own]; delete s.tables[own]; }
			});
		}
		if (ctx.exports) {
			s.exports.export_csv = (await capture(p, '#export-filings', parseDownload))?.[0] ?? { name: '(nothing captured)' };
			s.exports.export_register_csv = (await capture(p, '#export-register', parseDownload))?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		/** v5's register_edit: add two synthetic filings, delete the first shown register row, read the overview tiles. */
		async register_edit(p, ctx) {
			await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
			const out = await registerEdit(p, ctx, { count: `document.querySelectorAll('#filing-register tbody tr[data-key]').length` });
			const tiles = await readOverviewTiles(p, ctx);
			for (const [label, t] of Object.entries(tiles)) out[`overview.${label}`] = t.value;
			return out;
		},
	},
};
