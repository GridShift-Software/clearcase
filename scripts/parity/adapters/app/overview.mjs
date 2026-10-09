// App adapter: Overview (the pilot's view, GRS-12). Maps the app's elements onto the v5 snapshot ids.
import { fromRaw, remap } from '../../lib/snapshot.mjs';
import { navFocus, navList, open } from './_shell.mjs';

/** The app's tiles by v5 snapshot id, with v5's tile labels (the seeded sweep keys its values by label). */
const TILE_LABEL = {
	documents_indexed: 'Documents indexed', amount_due_to_date: 'Amount due (to date)', invoices: 'Invoices', open_deadlines: 'Open deadlines',
	unbilled_time: 'Unbilled time', contradiction_flags: 'Contradiction flags', scanned_need_ocr: 'Scanned (need OCR)',
};

/** Open the overview and read it as a v5-shaped snapshot. */
async function read(p, ctx) {
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
	return remap(s, {
		'kpi.without_extracted_text': 'scanned_need_ocr',
		'text.dates.1': 'quick_links.1',
	});
}

export default {
	view: 'overview',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/chronology', fromView: 'chronology', view: 'overview' });
		const out = await read(p, ctx);
		out.lists.navigation = await navList(p);
		out.focus.after_nav = nav.focus;
		out.texts['shell.crumb'] = nav.crumb;
		return out;
	},
	sweeps: {
		/**
		 * v5 seeds synthetic deadlines and timesheet entries, then reads every tile. The app has no deadline or timesheet
		 * register yet (GRS-17 fills those slots), so there is nothing to seed: the tiles are read as they are, under v5's
		 * labels, and the five tiles that do not depend on that user work are compared like the unseeded ones.
		 */
		async seeded_user_work(p, ctx) {
			const s = await read(p, ctx);
			return Object.fromEntries(Object.entries(TILE_LABEL).filter(([id]) => s.kpis[id]).flatMap(([id, label]) => [[`${label}.value`, s.kpis[id].value], [`${label}.sub`, s.kpis[id].sub]]));
		},
	},
};
