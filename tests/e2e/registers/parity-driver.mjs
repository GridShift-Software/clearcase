// Register drivers for the parity harness (GRS-17), shared by the registers' app adapters
// (scripts/parity/adapters/app/<view>.mjs), their v5 specs (scripts/parity/adapters/v5/specs/<view>.mjs) and the
// overview slot plug-ins (scripts/parity/adapters/app/slots/*.mjs). Everything goes through the UI a user sees: the
// app's register form, its Add, Edit and Delete buttons and its export, or v5's form and buttons. The app keeps user
// work for the whole run while v5 starts every sweep empty, so every app sweep deletes the rows it added and checks
// that the register is empty again before it returns.
import { sleep } from '../pilot/lib/cdp.mjs';
import { confirmPressed } from '../pilot/lib/confirm.mjs';
import { parseDownload } from '../../../scripts/parity/lib/exports.mjs';
import { slug } from '../../../scripts/parity/lib/normalize.mjs';
import { syntheticInput } from '../../../scripts/parity/lib/sweeps.mjs';

export const day = (clock, offset) => new Date(Date.parse(clock) + offset * 86400000).toISOString().slice(0, 10);
const ready = (view) => `document.querySelector('[data-ready="${view}"]')`;
/** A register page that is rendered and hydrated (its form is interactive). */
const interactive = (view) => `document.querySelector('[data-ready="${view}"][data-hydrated]')`;

// ---- app side -------------------------------------------------------------------------------------------------------

/** Open a register page and wait for it. */
export async function openRegister(p, ctx, view) {
	await p.goto(`${ctx.base}${ctx.registry[view].route}`, interactive(view));
	await p.settled();
}

/**
 * The register table's rows as v5's register sweep reads them: every cell's text joined with ' | ', the empty state
 * included. The row actions cell reads as v5's ('Delete'): the Edit control is the app's own addition (acceptance
 * beyond v5) and is left out of the join, so the rows compare with v5's cell for cell.
 */
export const appRows = (p) => p.evaluate(`(() => {
	const t = document.querySelector('#register-table');
	const n = t.tHead.rows[0].cells.length;
	const txt = (c) => { const k = c.cloneNode(true); k.querySelectorAll('[data-edit]').forEach((e) => e.remove()); return k.textContent.replace(/\\s+/g, ' ').trim(); };
	return [...t.tBodies[0].rows].map((r) => Array.from({ length: n }, (_, i) => (r.cells[i] ? txt(r.cells[i]) : '')).join(' | '));
})()`);

const rowCount = (p) => p.evaluate(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length`);
const rowIds = (p) => p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id]')].map((r) => r.dataset.rowId)`);

/**
 * Wait until the table holds `n` rows or the page shows a save or delete error. With `refusal`, a refused save is
 * returned as its message after its input is discarded (the page asks before leaving a page with unsaved input);
 * otherwise an error throws. Null when the rows arrived.
 */
async function waitRows(p, n, what, refusal = false) {
	await p.waitFor(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n} || !!document.getElementById('register-error') || !!document.getElementById('register-delete-error')`, 30000);
	const err = await p.evaluate(`(document.getElementById('register-error') ?? document.getElementById('register-delete-error'))?.querySelector('p')?.textContent ?? null`);
	if (err && refusal && (await p.evaluate(`!!document.getElementById('register-error')`))) {
		await p.click('#register-discard');
		await p.waitFor(`!document.getElementById('register-error')`, 5000);
		await p.settled();
		return err;
	}
	if (err) throw new Error(`register ${what}: ${err}`);
	await p.settled();
	return null;
}

/** Set one form field like a user agent does (value, then input and change events). */
const setField = (p, sel, value) => p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

/** The form's fields in order: {sel, tag, type, options}. */
const formFields = (p) => p.evaluate(`[...document.querySelectorAll('#register-form input, #register-form select, #register-form textarea')].filter((e) => e.getClientRects().length && e.type !== 'hidden').map((e) => ({ sel: '#' + e.id, tag: e.tagName.toLowerCase(), type: e.type, options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : null }))`);

/** Fill the form as v5's register sweep fills its own: synthetic values by input type, selects by the same rule. */
export async function fillSynthetic(p, ctx, n) {
	for (const f of await formFields(p)) {
		if (f.tag === 'select') { const v = f.options.find((o) => o) ?? ''; if (v) await setField(p, f.sel, f.options[Math.min(f.options.length - 1, f.options.indexOf(v) + n)]); }
		else await setField(p, f.sel, syntheticInput(f.type, n, ctx.clock));
	}
}

/** Fill the form from an entry keyed by v5 field keys (a key the form lacks is an error). */
export async function fillEntry(p, entry) {
	for (const [k, v] of Object.entries(entry)) if (!(await setField(p, `#in-${k}`, v))) throw new Error(`register form has no field ${k}`);
}

/** Press Add (or Save while editing) and wait until the table holds `expect` rows; see waitRows for `refusal`. */
export async function submit(p, expect, refusal = false) {
	if (!(await p.click('#register-save'))) throw new Error('register: no Add control');
	return waitRows(p, expect, 'save', refusal);
}

/** Add one entry through the form; returns its new row id. */
export async function addEntry(p, entry) {
	const before = await rowIds(p);
	await fillEntry(p, entry);
	await submit(p, before.length + 1);
	return (await rowIds(p)).find((id) => !before.includes(id));
}

/** Delete the shown row with this id, or the first shown row. */
export async function deleteRow(p, rowId = null) {
	const n = await rowCount(p);
	const sel = rowId ? `#register-table tr[data-row-id="${rowId}"] [data-delete]` : '#register-table tbody tr[data-row-id] [data-delete]';
	if (!(await p.click(sel))) throw new Error('register: no Delete control');
	await confirmPressed(p, '#register-table');
	await waitRows(p, n - 1, 'delete');
}

/** Delete every row (or every row not in `keep`) and check that only `keep` remains. */
export async function clearRegister(p, ctx, view, keep = []) {
	await openRegister(p, ctx, view);
	for (let guard = 0; guard < 1000; guard++) {
		const extra = (await rowIds(p)).filter((id) => !keep.includes(id));
		if (!extra.length) return;
		await deleteRow(p, extra[0]);
	}
	throw new Error(`register ${view}: could not empty it`);
}

/** The app register must start empty, as v5's does in every sweep. */
export async function requireEmpty(p, view) {
	const ids = await rowIds(p);
	if (ids.length) throw new Error(`register ${view} is not empty before a sweep (${ids.length} rows): an earlier sweep left rows behind`);
}

/** Press the register's export control and parse what it downloaded. */
export async function appExport(p) {
	await p.takeDownloads();
	if (!(await p.click('#register-export'))) return null;
	await sleep(80);
	const got = await p.takeDownloads();
	return got.length ? parseDownload(got[0]) : { name: '(nothing captured)' };
}

/** An ICS or CSV capture as sweep values: columns, row count and each cell. */
export function exportValues(prefix, x) {
	const out = { [`${prefix}.columns`]: (x?.columns ?? []).join(','), [`${prefix}.rows`]: String(x?.rows?.length ?? 0) };
	(x?.rows ?? []).forEach((r, i) => x.columns.forEach((c, j) => { out[`${prefix}.row.${i}.${c}`] = r[j]; }));
	return out;
}

// ---- v5 side --------------------------------------------------------------------------------------------------------

/** v5's register table rows (first table under #main), joined like its register sweep. */
export const v5Rows = (p) => p.evaluate(`(() => {
	const t = document.querySelector('#main table');
	const n = t.tHead.rows[0].cells.length;
	return [...t.tBodies[0].rows].map((r) => Array.from({ length: n }, (_, i) => (r.cells[i]?.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | '));
})()`);

/** Fill v5 fields by element id and press the view's Add button. */
export async function v5Add(p, fields) {
	for (const [id, v] of Object.entries(fields)) if (!(await setField(p, `#${id}`, v))) throw new Error(`v5: no field ${id}`);
	await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => /^\\s*add\\s*$/i.test(b.textContent))?.setAttribute('data-parity-add', '1')`);
	await p.click('[data-parity-add]');
	await sleep(20);
}

/** Press v5's Delete on the first shown row. */
export async function v5DeleteFirst(p) {
	await p.evaluate(`document.querySelector('#main table tbody tr button')?.setAttribute('data-parity-del', '1')`);
	await p.click('[data-parity-del]');
	await sleep(20);
}

/** Press the v5 control with this label and parse what it downloaded. */
export async function v5Export(p, label) {
	await p.takeDownloads();
	await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.setAttribute('data-parity-exp', '1')`);
	await p.click('[data-parity-exp]');
	await sleep(60);
	const got = await p.takeDownloads();
	return got.length ? parseDownload(got[0]) : { name: '(nothing captured)' };
}

// ---- shared sweeps --------------------------------------------------------------------------------------------------

/** Rows as sweep values under a step name. */
export const rowValues = (step, rows) => Object.fromEntries([[`${step}.rows`, String(rows.length)], ...rows.map((r, i) => [`${step}.row.${i}`, r])]);

/**
 * The app side of v5's register_edit sweep: two synthetic entries through the app's own form, Delete on the first
 * shown row, then the overview tiles (readOverviewTiles); afterwards every row is deleted again. The app refuses
 * v5's synthetic text in an amount, rate or hours field (S-disbursements_tab-1, S-timesheet_tab-3), so a refused
 * entry is discarded and the sweep goes on: its rows then differ from v5's, as registered.
 */
export async function appRegisterEdit(p, ctx, view, readOverviewTiles) {
	const out = {};
	await openRegister(p, ctx, view);
	await requireEmpty(p, view);
	try {
		for (let n = 0; n < 2; n++) {
			const before = await rowCount(p);
			await fillSynthetic(p, ctx, n);
			await submit(p, before + 1, true);
			Object.assign(out, rowValues(`add${n + 1}`, await appRows(p)));
		}
		if (await rowCount(p)) await deleteRow(p);
		Object.assign(out, rowValues('delete', await appRows(p)));
		for (const [label, t] of Object.entries(await readOverviewTiles(p, ctx))) out[`overview.${label}`] = t.value;
	} finally {
		await clearRegister(p, ctx, view);
	}
	return out;
}

/**
 * A register's app adapter: the page as a user sees it (navigation and focus from the overview, the rendered page, the
 * export control's download), v5's register_edit sweep, and any view-specific sweeps. `shell` passes the harness's
 * own helpers (fromRaw, navFocus, readOverviewTiles), so this module needs no path into the adapters folder.
 */
export function registerAdapter(view, exportLabel, shell, sweeps = {}) {
	return {
		view,
		async extract(p, ctx) {
			const nav = await shell.navFocus(p, ctx, { from: '/overview', fromView: 'overview', view });
			await openRegister(p, ctx, view);
			const s = shell.fromRaw(view, 'app', await p.extract('#main'));
			if (ctx.exports !== false) s.exports[slug(exportLabel)] = await appExport(p);
			s.focus.after_nav = nav.focus;
			s.texts['shell.crumb'] = nav.crumb;
			return s;
		},
		sweeps: { register_edit: (p, ctx) => appRegisterEdit(p, ctx, view, shell.readOverviewTiles), ...sweeps },
	};
}

// ---- the deadline order sweep (S-deadlines_tab-1, S-deadlines_tab-2) -------------------------------------------------

/**
 * Three synthetic deadlines entered out of date order, with a comma, a semicolon, a backslash and a line break in the
 * text (a single-line input drops the line break on both sides, as browsers do; the calendar's line-break escaping is
 * unit-tested).
 */
export const deadlineOrderEntries = (clock) => [
	{ title: 'Synthetic later, with comma; semicolon \\ backslash\nbreak', date: day(clock, 20), cat: 'Hearing', note: 'note, one; two' },
	{ title: 'Synthetic earlier', date: day(clock, 5), cat: 'Filing', note: '' },
	{ title: 'Synthetic middle', date: day(clock, 12), cat: 'Payment', note: 'mid\nline' },
];

/** v5: add the three, read the rows, export the calendar, Delete on the first shown row, read and export again. */
export async function v5DeadlineOrder(p, ctx) {
	await p.load({});
	await p.go('deadlines_tab');
	for (const e of deadlineOrderEntries(ctx.clock)) await v5Add(p, { dl_title: e.title, dl_date: e.date, dl_cat: e.cat, dl_note: e.note });
	const out = { ...rowValues('added', await v5Rows(p)), ...exportValues('ics_added', await v5Export(p, 'Export .ics')) };
	await v5DeleteFirst(p);
	return { ...out, ...rowValues('deleted', await v5Rows(p)), ...exportValues('ics', await v5Export(p, 'Export .ics')) };
}

/** The app: the same steps through the app's form, then every row is deleted again. */
export async function appDeadlineOrder(p, ctx) {
	await openRegister(p, ctx, 'deadlines_tab');
	await requireEmpty(p, 'deadlines_tab');
	try {
		for (const e of deadlineOrderEntries(ctx.clock)) await addEntry(p, e);
		const out = { ...rowValues('added', await appRows(p)), ...exportValues('ics_added', await appExport(p)) };
		await deleteRow(p);
		return { ...out, ...rowValues('deleted', await appRows(p)), ...exportValues('ics', await appExport(p)) };
	} finally {
		await clearRegister(p, ctx, 'deadlines_tab');
	}
}

// ---- overview slot plug-ins ------------------------------------------------------------------------------------------

/** A tile slot's figure and caption, read from the open overview as v5's tile reads. */
export const readSlot = (p, slot) => p.evaluate(`(() => { const s = document.querySelector('[data-slot="${slot}"]'); const ps = [...s.querySelectorAll('p')]; return { value: (s.querySelector('.num')?.textContent ?? '').replace(/\\s+/g, ' ').trim(), sub: ps.filter((x) => !x.classList.contains('num')).map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).join(' ') }; })()`);

/** A slot plug-in that enters `rows[key]` into a register through its form and deletes exactly those rows again. */
export function slotPlugin(slot, view, key) {
	let kept = null;
	return {
		read: (p) => readSlot(p, slot),
		async seed(p, ctx, rows) {
			await openRegister(p, ctx, view);
			kept = await rowIds(p);
			for (const r of rows[key] ?? []) await addEntry(p, r);
		},
		async cleanup(p, ctx) {
			await clearRegister(p, ctx, view, kept ?? []);
			kept = null;
		},
	};
}

// ---- the doc ref sweep (S-privilege_tab-1, S-annotations_tab-1) ------------------------------------------------------

/** A ref that names no document of any version (synthetic). */
export const MISSING_REF = 'Synthetic missing ref';
/** Each row's typed ref cell: whether it is a link, and the row's text. */
const refCells = (rows) => Object.fromEntries(rows.flatMap((r, i) => [[`${i}.ref`, r.link ? 'link' : 'text'], [`${i}.row`, r.text]]));

/**
 * v5: two entries with only a Doc ref, the first naming the first document the chronology shows, the second naming
 * nothing; then whether each row's ref is a link. The ref is read from the chronology, never written into a key.
 */
export async function v5DocRefLink(p, ctx, view, refField) {
	await p.load({});
	await p.go('chronology');
	const first = await p.evaluate(`document.querySelector('#chronWrap tbody tr')?.cells[1]?.textContent.trim() ?? ''`);
	await p.go(view);
	for (const ref of [first, MISSING_REF]) await v5Add(p, { [refField]: ref });
	return refCells(await p.evaluate(`[...document.querySelectorAll('#main table tbody tr')].map((r) => ({ link: !!r.cells[0]?.querySelector('a'), text: [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ') }))`));
}

/** The app: the same two entries through the app's form, the same reading, then every row is deleted again. */
export async function appDocRefLink(p, ctx, view) {
	await p.goto(`${ctx.base}/chronology`, ready('chronology'));
	await p.settled();
	const first = await p.evaluate(`document.querySelector('#main [role=row][data-ref]')?.dataset.ref ?? ''`);
	await openRegister(p, ctx, view);
	await requireEmpty(p, view);
	try {
		for (const ref of [first, MISSING_REF]) await addEntry(p, { ref });
		return refCells(await p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id]')].map((r) => ({ link: !!r.cells[0]?.querySelector('a'), text: [...r.cells].map((c) => { const k = c.cloneNode(true); k.querySelectorAll('[data-edit]').forEach((e) => e.remove()); return k.textContent.replace(/\\s+/g, ' ').trim(); }).join(' | ') }))`));
	} finally {
		await clearRegister(p, ctx, view);
	}
}
