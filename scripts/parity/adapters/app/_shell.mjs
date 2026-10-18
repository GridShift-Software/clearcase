// Shared app-side helpers for adapters (files starting with '_' are not adapters). Every adapter reads the app the
// way a user sees it: real navigation, the rendered DOM, real clicks; never the database or page data.
import { basename, join } from 'node:path';
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { importModule, moduleFiles } from '../../lib/modules.mjs';
import { fromRaw, remap } from '../../lib/snapshot.mjs';

export const ready = (view) => `document.querySelector('[data-ready="${view}"]')`;

/** Open a view at its route and wait until it is ready and every incremental grid has all rows. */
export async function open(p, ctx, route, view) {
	await p.goto(`${ctx.base}${route}`, ready(view));
	await p.settled();
}

/**
 * Navigation and focus, as on the v5 side: from another view, click the view's sidebar link with the mouse, wait for
 * the destination, then read where focus is and which entry is marked current (the app's equivalent of v5's crumb).
 */
export async function navFocus(p, ctx, { from, fromView, view }) {
	await open(p, ctx, from, fromView);
	await p.click(`#nav-${view}`);
	await p.waitFor(`${ready(view)} && location.pathname.endsWith(${JSON.stringify(ctx.registry[view].route)})`, 60000);
	await sleep(60);
	return { focus: await p.focusRole(), crumb: await p.evaluate(`document.querySelector('nav.views a[aria-current="page"]')?.firstChild?.textContent.trim() ?? ''`) };
}

/** Read a simple view, keeping its hydration requirements and export/sweep work in its own adapter. */
export async function readSimpleView(p, ctx, view, { openView = open, hydrate } = {}) {
	const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view });
	await openView(p, ctx, ctx.registry[view].route, view);
	if (hydrate) await hydrate(p);
	const s = fromRaw(view, 'app', await p.extract('#main'));
	s.focus.after_nav = nav.focus;
	s.texts['shell.crumb'] = nav.crumb;
	return s;
}

/** The sidebar as 'Group / Label' entries in order (the screen-reader-only availability note is not part of a label). */
export const navList = (p) => p.evaluate(`[...document.querySelectorAll('nav.views section')].flatMap((s) => [...s.querySelectorAll('a')].map((a) => s.querySelector('h2').textContent.trim() + ' / ' + a.firstChild.textContent.trim()))`);

/** Press a control and return the parsed downloads it produced (content, not bytes). */
export async function pressAndCapture(p, selector, parseDownload) {
	await p.takeDownloads();
	if (!(await p.click(selector))) return null;
	await sleep(80);
	const out = [];
	for (const d of await p.takeDownloads()) out.push(await parseDownload(d));
	return out;
}

/** The overview's tiles by v5 snapshot id, with v5's tile labels (sweeps key their values by label). */
export const TILE_LABEL = Object.freeze({
	documents_indexed: 'Documents indexed', amount_due_to_date: 'Amount due (to date)', invoices: 'Invoices', open_deadlines: 'Open deadlines',
	unbilled_time: 'Unbilled time', contradiction_flags: 'Contradiction flags', scanned_need_ocr: 'Scanned (need OCR)',
});
/** The overview slots that stand where v5 shows a tile, by slot id. */
const SLOT_TILE = { deadlines: 'open_deadlines', 'unbilled-time': 'unbilled_time' };
export const SLOTS_DIR = join(import.meta.dirname, 'slots');
const isFn = (f) => typeof f === 'function';

/**
 * The slot plug-ins in `dir` (default adapters/app/slots/): one module per overview slot, `<slot-id>.mjs`, whose
 * default export (or named exports) is `{ read(p, ctx) -> {value, sub}, seed(p, ctx, rows), cleanup(p, ctx) }`. A
 * slot's owner adds its own file; files starting with '_' are skipped. A name that is not a declared slot, or a
 * module without the three functions, is an error. Returns a Map in slot declaration order.
 */
export async function loadSlotPlugins(dir = SLOTS_DIR, root = join(import.meta.dirname, '..', '..', '..', '..')) {
	const { OVERVIEW_SLOTS } = await import(join(root, 'src', 'lib', 'components', 'overview-slots.ts'));
	const ids = OVERVIEW_SLOTS.map((s) => s.id);
	const found = new Map();
	for (const f of moduleFiles(dir).map((p) => basename(p))) {
		const id = f.slice(0, -'.mjs'.length);
		if (!ids.includes(id)) throw new Error(`slot plug-in ${f}: ${id} is not an overview slot (${ids.join(', ')})`);
		const mod = await importModule(join(dir, f));
		const pl = mod.default ?? mod;
		if (!isFn(pl.read) || !isFn(pl.seed) || !isFn(pl.cleanup)) throw new Error(`slot plug-in ${f} must export read(p, ctx), seed(p, ctx, rows) and cleanup(p, ctx)`);
		found.set(id, { read: pl.read, seed: pl.seed, cleanup: pl.cleanup });
	}
	return new Map(ids.filter((id) => found.has(id)).map((id) => [id, found.get(id)]));
}

/** The run's slot plug-ins, loaded once per run (`ctx.slotPlugins` may be set beforehand, as the tests do). */
export async function slotPlugins(ctx) {
	ctx.slotPlugins ??= await loadSlotPlugins(SLOTS_DIR, ctx.appRoot);
	return ctx.slotPlugins;
}

/** Throw unless the page is still the overview (a plug-in's read() must not navigate away). */
export async function assertOverview(p, who) {
	const ok = await p.evaluate(`location.pathname.endsWith('/overview') && !!${ready('overview')}`);
	if (ok !== true) throw new Error(`${who} left the overview: read() must read the overview page in place, without navigating`);
}

/**
 * Open the overview and read it as a v5-shaped snapshot. The widget slots stand where v5 shows the deadline and
 * unbilled-time tiles and the freshness card: a filled slot is read by its plug-in's read(p, ctx) as {value, sub}
 * (the freshness slot as text.freshness.1 and, when sub is not empty, .2), after which the page must still be the
 * overview; a filled slot without a plug-in is an error. An unfilled slot is recorded with its wording, so it
 * compares as a value and not as a missing tile.
 */
export async function readOverviewSnapshot(p, ctx) {
	await open(p, ctx, '/overview', 'overview');
	const raw = await p.extract('#main');
	const s = fromRaw('overview', 'app', raw);
	const slots = await p.evaluate(`[...document.querySelectorAll('#main [data-slot]')].map((e) => ({ id: e.dataset.slot, status: e.dataset.slotStatus, label: e.querySelector('h2')?.textContent.trim() ?? '', text: [...e.querySelectorAll('p')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).join(' ') }))`);
	const plugins = await slotPlugins(ctx);
	for (const sl of slots) {
		for (const k of Object.keys(s.texts)) if (k.startsWith(`${sl.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.`)) delete s.texts[k];
		const pl = sl.status === 'filled' ? plugins.get(sl.id) : undefined;
		if (sl.status === 'filled' && !pl) throw new Error(`overview slot ${sl.id} is filled but has no parity plug-in: add scripts/parity/adapters/app/slots/${sl.id}.mjs`);
		const got = pl ? await pl.read(p, ctx) : { value: sl.text, sub: '' };
		if (pl) await assertOverview(p, `slot plug-in ${sl.id}`);
		if (SLOT_TILE[sl.id]) s.kpis[SLOT_TILE[sl.id]] = { label: sl.label, value: got.value, sub: got.sub };
		else {
			s.texts[`${sl.id === 'rescan-freshness' ? 'freshness' : sl.id}.1`] = got.value;
			if (pl && got.sub) s.texts[`${sl.id === 'rescan-freshness' ? 'freshness' : sl.id}.2`] = got.sub;
		}
	}
	return remap(s, {
		'kpi.without_extracted_text': 'scanned_need_ocr',
		'text.dates.1': 'quick_links.1',
	});
}

/**
 * The overview's seven tiles as `{ '<v5 tile label>': {value, sub} }`, read through the real overview page (slot
 * plug-ins included). Any adapter's sweep that ends on the overview tiles, as v5's register_edit sweep does
 * (`overview.<label>` = value), reads them here.
 */
export async function readOverviewTiles(p, ctx) {
	const s = await readOverviewSnapshot(p, ctx);
	return Object.fromEntries(Object.entries(TILE_LABEL).filter(([id]) => s.kpis[id]).map(([id, label]) => [label, { value: s.kpis[id].value, sub: s.kpis[id].sub }]));
}
