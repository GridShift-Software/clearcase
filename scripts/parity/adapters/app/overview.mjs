// App adapter: Overview (the pilot's view, GRS-12). Maps the app's elements onto the v5 snapshot ids.
import { fromRaw, remap } from '../../lib/snapshot.mjs';
import { navFocus, navList, open } from './_shell.mjs';

export default {
	view: 'overview',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/chronology', fromView: 'chronology', view: 'overview' });
		await open(p, ctx, '/overview', 'overview');
		const raw = await p.extract('#main');
		const s = fromRaw('overview', 'app', raw);
		// Overview widget slots stand where v5 shows the deadline and unbilled-time tiles and the freshness card; an
		// unfilled slot is recorded with its wording, so it compares as a value and not as a missing tile.
		const slots = await p.evaluate(`[...document.querySelectorAll('#main [data-slot]')].map((e) => ({ id: e.dataset.slot, status: e.dataset.slotStatus, label: e.querySelector('h2')?.textContent.trim() ?? '', text: [...e.querySelectorAll('p')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).join(' ') }))`);
		const tile = { deadlines: 'open_deadlines', 'unbilled-time': 'unbilled_time' };
		for (const sl of slots) {
			for (const k of Object.keys(s.texts)) if (k.startsWith(`${sl.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.`)) delete s.texts[k];
			if (tile[sl.id]) s.kpis[tile[sl.id]] = { label: sl.label, value: sl.text, sub: '' };
			else s.texts[`${sl.id === 'rescan-freshness' ? 'freshness' : sl.id}.1`] = sl.text;
		}
		const out = remap(s, {
			'kpi.without_extracted_text': 'scanned_need_ocr',
			'text.dates.1': 'quick_links.1',
		});
		out.lists.navigation = await navList(p);
		out.focus.after_nav = nav.focus;
		out.texts['shell.crumb'] = nav.crumb;
		return out;
	},
};
