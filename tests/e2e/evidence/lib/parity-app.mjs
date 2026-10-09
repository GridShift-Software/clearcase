// Helpers shared by the evidence views' app parity adapters (scripts/parity/adapters/app/<view>.mjs, GRS-14). They read
// the app as a user sees it: the rendered DOM, real clicks and the downloads the page produces.
import { sleep } from '../../pilot/lib/cdp.mjs';
import { domExtract } from '../../../../scripts/parity/lib/dom.mjs';
import { tableFromRaw } from '../../../../scripts/parity/lib/snapshot.mjs';
import { syntheticInput } from '../../../../scripts/parity/lib/sweeps.mjs';
import { open } from '../../../../scripts/parity/adapters/app/_shell.mjs';

/** The rows of the first table under #main as joined cell text (the v5 register sweep's reading). */
export async function firstTableRows(p) {
	const raw = await p.evaluate(`(${domExtract.toString()})('#main', {})`);
	const t = raw.tables[0];
	if (!t) return [];
	const tab = tableFromRaw(t);
	return tab.rows.map((r) => tab.columns.map((c) => r[c.id]).join(' | '));
}

/** Press a control and wait (up to `ms`) for the downloads it produces; parsed by `parse`. */
export async function capture(p, selector, parse, ms = 5000) {
	await p.takeDownloads();
	if (!(await p.click(selector))) return null;
	const t0 = Date.now();
	let got = [];
	while (!got.length && Date.now() - t0 < ms) { await sleep(40); got = await p.takeDownloads(); }
	const out = [];
	for (const d of got) out.push(await parse(d));
	return out;
}

/**
 * v5's register_edit sequence through the app's own form: two adds with every visible field outside tables filled
 * by input type, a delete of the first row with a Delete button, recording the first table after each step.
 * `changed` is a page expression that turns true once a step's write has rendered.
 */
export async function registerEdit(p, ctx, { count, out = {} }) {
	const record = async (step) => { const rows = await firstTableRows(p); out[`${step}.rows`] = String(rows.length); rows.forEach((r, i) => { out[`${step}.row.${i}`] = r; }); };
	for (let n = 0; n < 2; n++) {
		const fields = await p.evaluate(`[...document.querySelectorAll('#main input, #main select, #main textarea')].filter((e) => e.getClientRects().length && !e.closest('table') && e.type !== 'file' && e.type !== 'checkbox').map((e, i) => { e.setAttribute('data-parity-field', String(i)); return { i, tag: e.tagName.toLowerCase(), type: e.type, options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : null }; })`);
		for (const f of fields) {
			const sel = `[data-parity-field="${f.i}"]`;
			if (f.tag === 'select') { const v = f.options.find((o) => o) ?? ''; if (v) await p.select(sel, f.options[Math.min(f.options.length - 1, f.options.indexOf(v) + n)]); }
			else await p.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(syntheticInput(f.type, n, ctx.clock))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		}
		const before = await p.evaluate(count);
		const add = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main button')].find((b) => /^\\s*\\+?\\s*add\\b/i.test(b.textContent) && b.getClientRects().length && !b.closest('table')); if (!b) return false; b.setAttribute('data-parity-add', '1'); return true; })()`);
		if (!add) { out.add = 'no-add-control'; return out; }
		await p.click('[data-parity-add]');
		await p.waitFor(`(${count}) !== ${JSON.stringify(before)}`, 20000).catch(() => {});
		await sleep(20);
		await record(`add${n + 1}`);
	}
	const before = await p.evaluate(count);
	const del = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main table tbody tr button')].find((b) => /delete|remove|×|✕/i.test(b.textContent + (b.title || ''))); if (!b) return false; b.setAttribute('data-parity-del', '1'); return true; })()`);
	if (del) { await p.click('[data-parity-del]'); await p.waitFor(`(${count}) !== ${JSON.stringify(before)}`, 20000).catch(() => {}); await sleep(20); await record('delete'); } else out.delete = 'no-delete-control';
	return out;
}

/** The pager's wording, as v5's adapter reads it (innerText, white space collapsed). */
export const pagerText = (p, pager) => p.evaluate(`document.querySelector(${JSON.stringify(pager)})?.innerText.replace(/\\s+/g, ' ').trim() ?? null`);

/**
 * Every page of a server-paged table through its Next button, as v5's adapter pages: the rows of pages 2.. are
 * appended to `table` (raw extractor rows). The page waits for #main's data-page to advance and its navigation to end.
 */
export async function pageThroughApp(p, { pager, table, rows }) {
	for (let i = 0; i < 400; i++) {
		const st = await p.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(pager)} + ' button')].find((x) => /next/i.test(x.textContent)); if (!b || b.disabled) return null; b.setAttribute('data-parity-next', '1'); return document.getElementById('main').dataset.page; })()`);
		if (st === null) return;
		await p.click('[data-parity-next]');
		await p.waitFor(`document.getElementById('main').dataset.page === ${JSON.stringify(String(+st + 1))} && !document.getElementById('main').dataset.busy`, 20000);
		const t = (await p.extract(table))?.tables?.[0];
		if (!t) return;
		rows.push(...t.rows);
	}
}

/** Every data-ref of a server-paged table, page by page through its pager's Next button. */
export async function refsThroughPages(p, { pager, rows }) {
	const refs = await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(rows)})].map((r) => r.dataset.ref)`);
	for (let i = 0; i < 400; i++) {
		const st = await p.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(pager)} + ' button')].find((x) => /next/i.test(x.textContent)); if (!b || b.disabled) return null; b.setAttribute('data-parity-next', '1'); return document.getElementById('main').dataset.page; })()`);
		if (st === null) return refs;
		await p.click('[data-parity-next]');
		await p.waitFor(`document.getElementById('main').dataset.page === ${JSON.stringify(String(+st + 1))} && !document.getElementById('main').dataset.busy`, 20000);
		refs.push(...(await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(rows)})].map((r) => r.dataset.ref)`)));
	}
	return refs;
}

/** Open an evidence view and wait until its controls respond: data-ready is in the server's HTML, data-hydrated
 *  follows when the page has mounted. */
export async function openHydrated(p, ctx, route, view) {
	await open(p, ctx, route, view);
	await p.waitFor(`document.querySelector('main#main')?.dataset.hydrated === '1'`, 60000);
}
