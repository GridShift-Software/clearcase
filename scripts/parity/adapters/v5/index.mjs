// The v5 side for all 42 views. One generic adapter drives the workspace UI the way a user does: open the view
// from a clean load, read what is shown, page through every pager with its Next button, press every export or print
// control and capture the content, and record where focus lands after navigating with the sidebar. Per-view specs
// (./specs.mjs and ./specs/<view-id>.mjs) add parameterized interaction sweeps on top. Nothing here reads DATA or
// other page internals except where a spec says so (the chronology engine sweep, which reuses the parity trial's
// library-level driving).
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw, tableFromRaw } from '../../lib/snapshot.mjs';
import { slug } from '../../lib/normalize.mjs';
import { loadSpecs, registerSweep } from './specs.mjs';

export const EXPORT_CONTROL = /export|download|\bcsv\b|\.ics|\bics\b|print|\bpdf\b|backup/i;
const NOT_EXPORT = /import|restore|upload/i;
const MAX_PAGES = 400;

/** Tag pager k's Next button and its table (the element before the pager); returns the pager state. */
const tagPager = (p, k) => p.evaluate(`(() => { document.querySelectorAll('[data-parity-next],[data-parity-paged]').forEach((e) => { e.removeAttribute('data-parity-next'); e.removeAttribute('data-parity-paged'); });
	const pg = document.querySelectorAll('#main .pager')[${k}]; if (!pg) return null;
	const next = [...pg.querySelectorAll('button')].find((b) => /next/i.test(b.textContent)); if (next) next.setAttribute('data-parity-next', '1');
	let t = pg.previousElementSibling; while (t && !t.matches('table, [role=table]') && !t.querySelector('table')) t = t.previousElementSibling;
	if (t && !t.matches('table')) t = t.querySelector('table'); if (t) t.setAttribute('data-parity-paged', '1');
	const all = [...document.querySelectorAll('#main table, #main [role=table]')].filter((x) => x.getClientRects().length);
	return { index: t ? all.indexOf(t) : -1, enabled: !!next && !next.disabled, text: pg.innerText.replace(/\\s+/g, ' ').trim() }; })()`);

/** Every page of every paged table, through the Next buttons; rows are appended to the page-1 extraction. */
async function pageThrough(p, raw) {
	const pagers = await p.evaluate(`document.querySelectorAll('#main .pager').length`);
	const info = [];
	for (let k = 0; k < pagers; k++) {
		let st = await tagPager(p, k);
		const first = st;
		let pages = 1;
		while (st?.enabled && st.index >= 0 && pages < MAX_PAGES) {
			await p.click('[data-parity-next]');
			await sleep(5);
			st = await tagPager(p, k);
			const t = (await p.extract('[data-parity-paged]'))?.tables?.[0];
			if (!t) break;
			raw.tables[first.index].rows.push(...t.rows);
			pages++;
		}
		info.push({ table: first.index, pages, text: first.text });
	}
	return info;
}

/** Labels of the export and print controls shown in the view (top-level, not per-row). */
const exportControls = (p) => p.evaluate(`[...document.querySelectorAll('#main button, #main a[download], #main [role=button]')].filter((e) => e.getClientRects().length && !e.closest('tbody tr')).map((e, i) => ({ i, label: e.innerText.replace(/\\s+/g, ' ').trim() || e.getAttribute('title') || '' }))`);

/** Press one control by its index among the visible top-level controls. */
const pressControl = (p, i) => p.evaluate(`(() => { const e = [...document.querySelectorAll('#main button, #main a[download], #main [role=button]')].filter((e) => e.getClientRects().length && !e.closest('tbody tr'))[${i}]; if (!e) return false; e.setAttribute('data-parity-press', '1'); return true; })()`).then((ok) => ok && p.click('[data-parity-press]'));

export async function extractV5View(p, view, ctx) {
	const spec = (await loadSpecs())[view] ?? {};
	const storage = spec.storage ?? {};
	const t0 = performance.now();
	await p.load(storage);
	await p.go(view);
	const raw = await p.extract('#main');
	const pagers = await pageThrough(p, raw);
	spec.postRaw?.(raw);
	const s = fromRaw(view, 'v5', raw, { tableKey: spec.key ?? 'ref' });
	// the pager is part of what v5 shows: its page-1 wording and totals
	const tableIds = Object.keys(s.tables);
	for (const pg of pagers) {
		const id = tableIds[pg.table] ?? `table_${pg.table + 1}`;
		s.texts[`${id}.pager`] = pg.text;
		const m = /of ([\d,\s]+)\s*$/.exec(pg.text);
		if (m) s.counts[`${id}.total`] = m[1].trim();
	}
	if (ctx.exports !== false) {
		const controls = (await exportControls(p)).filter((c) => EXPORT_CONTROL.test(c.label) && !NOT_EXPORT.test(c.label));
		for (const c of controls) {
			await p.load(storage);
			await p.go(view);
			await pressControl(p, c.i);
			await sleep(60);
			const downloads = await p.takeDownloads();
			const print = await p.takePrint();
			const id = slug(c.label);
			for (const [j, d] of downloads.entries()) s.exports[j ? `${id}_${j + 1}` : id] = await parseDownload(d);
			if (print.prints) s.exports[`${id}.print`] = { name: 'print', text: print.text ?? '' };
			if (!downloads.length && !print.prints) s.exports[id] = { name: '(nothing captured)' };
		}
	}
	// navigation and focus: open the view from the sidebar with a real click, then read focus and the crumb
	await p.load(storage);
	if (await p.click(`#nav [data-tab="${view}"]`)) {
		await sleep(40);
		s.focus.after_nav = await p.focusRole();
		s.texts['shell.crumb'] = await p.evaluate(`document.getElementById('crumb')?.textContent ?? ''`);
	}
	const sweeps = [...(spec.sweeps ?? [])];
	if (Object.keys(s.controls).some((k) => /^button:\+? ?Add\b/i.test(k))) sweeps.push(registerSweep);
	if (ctx.sweeps !== false) for (const sw of sweeps) s.sweeps[sw.id] = await sw.v5(p, ctx, view);
	s.ms = Math.round(performance.now() - t0);
	return s;
}

/** The shell's navigation entries in order ('Group / Label'), for the overview snapshot. */
export const v5Nav = (p) => p.evaluate(`[...document.querySelectorAll('#nav .navsec')].flatMap((s) => [...s.querySelectorAll('a[data-tab]')].map((a) => s.querySelector('h4').textContent.trim() + ' / ' + a.textContent.trim()))`);

export { tableFromRaw };
