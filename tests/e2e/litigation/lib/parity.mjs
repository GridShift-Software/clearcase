// App-side parity helpers shared by the litigation adapters (scripts/parity/adapters/app/<view>.mjs, GRS-18). They
// read the app the way a user sees it: the rendered DOM and real clicks, never the database or page data.
import { sleep } from '../../pilot/lib/cdp.mjs';
import { confirmIfAsked } from '../../pilot/lib/confirm.mjs';
import { domExtract } from '../../../../scripts/parity/lib/dom.mjs';
import { syntheticInput } from '../../../../scripts/parity/lib/sweeps.mjs';
import { tableFromRaw } from '../../../../scripts/parity/lib/snapshot.mjs';
import { open, readOverviewTiles } from '../../../../scripts/parity/adapters/app/_shell.mjs';

/** Open a litigation view at its route and wait until its controls work (main[data-hydrated]). */
export async function openHydrated(p, ctx, view) {
	await open(p, ctx, ctx.registry[view].route, view);
	await p.waitFor(`document.querySelector('main#main')?.dataset.hydrated === '1'`, 60000);
	await p.settled();
}

/** The rows of the first table under #main, as joined cell text (the v5 register sweep's reading). */
export async function tableRows(p) {
	const raw = await p.evaluate(`(${domExtract.toString()})('#main', {})`);
	const t = raw.tables[0];
	if (!t) return [];
	const tab = tableFromRaw(t);
	return tab.rows.map((r) => tab.columns.map((c) => r[c.id]).join(' | '));
}

/** Wait until the first table's rows differ from `before` and nothing is in flight (a form round trip and the page's reload of its data). */
async function changed(p, before, timeout = 15000) {
	const t0 = Date.now();
	for (;;) {
		await p.settled();
		// a Delete or Add still in flight ('Deleting…', 'Saving the entry…') is not the new state yet
		const busy = await p.evaluate(`!!document.querySelector('#main [aria-busy="true"], #main [data-saving]')`);
		const now = await tableRows(p);
		if (!busy && JSON.stringify(now) !== JSON.stringify(before)) return now;
		if (Date.now() - t0 > timeout) return now;
		await sleep(20);
	}
}

/**
 * v5's register_edit sweep through the app's own form: fill every visible field outside tables by input type, press
 * the first Add, twice; record the rows after each; delete the first shown row; then read the overview tiles.
 * `cleanup(p)` runs before the overview is read and removes what the sweep added where a Delete exists, since the app
 * keeps user work for the whole run while v5 starts each sweep with empty storage.
 */
export async function registerEdit(p, ctx, view, { cleanup } = {}) {
	const out = {};
	await openHydrated(p, ctx, view);
	const record = (step, rows) => { out[`${step}.rows`] = String(rows.length); rows.forEach((r, i) => { out[`${step}.row.${i}`] = r; }); };
	let rows = await tableRows(p);
	for (let n = 0; n < 2; n++) {
		const fields = await p.evaluate(`[...document.querySelectorAll('#main input, #main select, #main textarea')].filter((e) => e.getClientRects().length && !e.closest('table') && e.type !== 'file' && e.type !== 'checkbox' && e.type !== 'hidden').map((e, i) => { e.setAttribute('data-parity-field', String(i)); return { i, tag: e.tagName.toLowerCase(), type: e.type, options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : null }; })`);
		for (const f of fields) {
			const sel = `[data-parity-field="${f.i}"]`;
			if (f.tag === 'select') { const v = f.options.find((o) => o) ?? ''; if (v) await p.select(sel, f.options[Math.min(f.options.length - 1, f.options.indexOf(v) + n)]); }
			else await p.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(syntheticInput(f.type, n, ctx.clock))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		}
		const add = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main button')].find((b) => /^\\s*\\+?\\s*add\\b/i.test(b.textContent) && b.getClientRects().length && !b.closest('table')); if (!b) return false; b.setAttribute('data-parity-add', '1'); return true; })()`);
		if (!add) { out.add = 'no-add-control'; return out; }
		await p.click('[data-parity-add]');
		rows = await changed(p, rows);
		record(`add${n + 1}`, rows);
	}
	const del = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main table tbody tr button')].find((b) => /delete|remove|×|✕/i.test(b.textContent + (b.title || ''))); if (!b) return false; b.setAttribute('data-parity-del', '1'); return true; })()`);
	if (del) { await p.click('[data-parity-del]'); await confirmIfAsked(p, '#main', 1500); rows = await changed(p, rows); record('delete', rows); } else out.delete = 'no-delete-control';
	if (cleanup) await cleanup(p);
	for (const [label, t] of Object.entries(await readOverviewTiles(p, ctx))) out[`overview.${label}`] = t.value;
	return out;
}

/** Press the Delete of every row whose text contains `marker` (the sweep's synthetic entries), one at a time. */
export async function deleteRowsWith(p, marker) {
	for (let i = 0; i < 50; i++) {
		const before = await tableRows(p);
		// a row whose Delete is still in flight (disabled, 'Deleting…') is waited for, not pressed again
		const hit = await p.evaluate(`(() => { const rows = [...document.querySelectorAll('#main table tbody tr')].filter((r) => r.textContent.includes(${JSON.stringify(marker)}) && r.querySelector('button')); if (!rows.length) return false; const b = rows.map((r) => [...r.querySelectorAll('button')].find((b) => /^delete$/i.test(b.textContent.trim()) && !b.disabled)).find(Boolean); if (!b) return 'busy'; b.setAttribute('data-parity-clean', String(${i})); return true; })()`);
		if (!hit) return;
		if (hit === 'busy') { await new Promise((r) => setTimeout(r, 100)); continue; }
		await p.click(`[data-parity-clean="${i}"]`);
		await changed(p, before);
	}
	throw new Error(`cleanup: rows with ${marker} remain`);
}
