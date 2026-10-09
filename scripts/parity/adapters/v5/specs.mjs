// Per-view additions to the generic v5 adapter: interaction sweeps. Each sweep has an id and a v5 driver returning
// { comboKey: value }; the app adapter of the same view implements the same sweep id. Views without an entry get the
// generic extraction, export capture, focus check and (for any view with an Add control) the register sweep.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { FNV_SRC, SORTS, engineCombos, seededUserWork, seqValue, syntheticInput, uiCombos } from '../../lib/sweeps.mjs';
import { domExtract } from '../../lib/dom.mjs';
import { tableFromRaw } from '../../lib/snapshot.mjs';

const V5_SORT = { date: 'Date', ref: 'Ref', docType: 'Type', bundle: 'Bundle', amount: 'Amount' };
const V5_SORT_KEY = { date: 'date', ref: 'ref', docType: 'doc_type', bundle: 'bundle', amount: 'amount' };

/** Click a v5 chronology column header until it shows the wanted direction (at most three clicks). */
async function v5Sort(p, k, d) {
	const want = `${V5_SORT[k]} ${d === 1 ? '▲' : '▼'}`;
	for (let i = 0; i < 3; i++) {
		const cur = await p.evaluate(`[...document.querySelectorAll('#chronWrap th')].map((t) => t.textContent.trim())`);
		if (cur.includes(want)) return true;
		await p.evaluate(`[...document.querySelectorAll('#chronWrap th')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(V5_SORT[k])}))?.setAttribute('data-parity-th', '1')`);
		await p.click('[data-parity-th]');
		await sleep(2);
	}
	return false;
}

/** Every ref the v5 chronology shows for the current filters, page by page through Next. */
async function v5ChronRefs(p) {
	const refs = [];
	for (let i = 0; i < 400; i++) {
		const page = await p.evaluate(`(() => { const rows = [...document.querySelectorAll('#chronWrap tbody tr')].map((r) => r.cells[1]?.textContent ?? ''); const next = [...document.querySelectorAll('#chronWrap .pager button')].find((b) => /next/i.test(b.textContent)); if (next && !next.disabled) next.setAttribute('data-parity-next', '1'); return { rows, more: !!next && !next.disabled, total: (/of ([\\d,]+)/.exec(document.querySelector('#chronWrap .pager .count')?.textContent ?? '') ?? [])[1] ?? null }; })()`);
		refs.push(...page.rows);
		if (!page.more) return { refs, total: page.total };
		await p.click('[data-parity-next]');
	}
	throw new Error('v5 chronology: more than 400 pages');
}

const chronologyUi = {
	id: 'filter_sort_ui',
	async v5(p, ctx) {
		const out = {};
		for (const c of uiCombos(ctx.dims)) {
			await p.load({});
			await p.go('chronology');
			const q = ctx.dims.queries[c.q];
			if (q) await p.type('#chq', q);
			let refused = null;
			for (const [sel, v] of [['#chb', ctx.dims.bundles[c.b]], ['#cht', ctx.dims.types[c.t]], ['#chs', ctx.dims.statuses[c.s]]]) {
				if (!v) continue;
				const r = await p.select(sel, v);
				if (r !== 'ok') { refused = r; break; }
			}
			if (refused) { out[c.key] = refused; continue; }
			if (!(await v5Sort(p, SORTS[c.k], c.d))) { out[c.key] = 'no-sort-control'; continue; }
			const { refs, total } = await v5ChronRefs(p);
			out[c.key] = `${seqValue(refs)}|shown ${String(total ?? refs.length).replace(/[,\s]/g, '')}`;
		}
		return out;
	},
};

/** Library-level grid over v5's own chronFiltered (the parity trial's driving), for breadth beyond the UI sweep. */
const chronologyEngine = {
	id: 'filter_sort_engine',
	async v5(p, ctx) {
		await p.load({});
		await p.go('chronology');
		const combos = engineCombos(ctx.dims).map((c) => [c.key, ctx.dims.bundles[c.b], ctx.dims.types[c.t], ctx.dims.statuses[c.s], ctx.dims.queries[c.q], V5_SORT_KEY[SORTS[c.k]], c.d]);
		return p.evaluate(`(() => { const fnv = ${FNV_SRC}; const saved = JSON.stringify(CH); const out = {};
			for (const [key, bundle, type, status, q, sort, dir] of ${JSON.stringify(combos)}) {
				CH.f = { q, bundle, type, status }; CH.sort = sort; CH.dir = dir;
				const refs = chronFiltered().map((r) => r.ref); out[key] = refs.length + '|' + fnv(refs.join('\\n'));
			}
			Object.assign(CH, JSON.parse(saved)); return out; })()`);
	},
};

/** Overview KPIs with synthetic deadlines and timesheet rows seeded (clock-relative). */
const overviewSeeded = {
	id: 'seeded_user_work',
	async v5(p, ctx) {
		await p.load(seededUserWork(ctx.clock));
		await p.go('overview');
		const raw = await p.extract('#main');
		return Object.fromEntries(raw.kpis.flatMap((k) => [[`${k.label}.value`, k.value], [`${k.label}.sub`, k.sub]]));
	},
};

/** The rows of the first table under #main, as joined cell text. */
async function tableRows(p) {
	const raw = await p.evaluate(`(${domExtract.toString()})('#main', {})`);
	const t = raw.tables[0];
	if (!t) return [];
	const tab = tableFromRaw(t);
	return tab.rows.map((r) => tab.columns.map((c) => r[c.id]).join(' | '));
}

/**
 * Register edit sequence on synthetic user work, through the UI: add two entries with the view's own form (each field
 * filled by input type), delete the first shown row, then read the overview KPIs. Records the rows after each step.
 */
export const registerSweep = {
	id: 'register_edit',
	async v5(p, ctx, view) {
		const out = {};
		await p.load({});
		await p.go(view);
		const record = async (step) => { const rows = await tableRows(p); out[`${step}.rows`] = String(rows.length); rows.forEach((r, i) => { out[`${step}.row.${i}`] = r; }); };
		for (let n = 0; n < 2; n++) {
			const fields = await p.evaluate(`[...document.querySelectorAll('#main input, #main select, #main textarea')].filter((e) => e.getClientRects().length && !e.closest('table') && e.type !== 'file' && e.type !== 'checkbox').map((e, i) => { e.setAttribute('data-parity-field', String(i)); return { i, tag: e.tagName.toLowerCase(), type: e.type, options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : null }; })`);
			for (const f of fields) {
				const sel = `[data-parity-field="${f.i}"]`;
				if (f.tag === 'select') { const v = f.options.find((o) => o) ?? ''; if (v) await p.select(sel, f.options[Math.min(f.options.length - 1, f.options.indexOf(v) + n)]); }
				else await p.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(syntheticInput(f.type, n, ctx.clock))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
			}
			const add = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main button')].find((b) => /^\\s*\\+?\\s*add\\b/i.test(b.textContent) && b.getClientRects().length && !b.closest('table')); if (!b) return false; b.setAttribute('data-parity-add', '1'); return true; })()`);
			if (!add) { out.add = 'no-add-control'; return out; }
			await p.click('[data-parity-add]');
			await sleep(20);
			await record(`add${n + 1}`);
		}
		const del = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main table tbody tr button')].find((b) => /delete|remove|×|✕/i.test(b.textContent + (b.title || ''))); if (!b) return false; b.setAttribute('data-parity-del', '1'); return true; })()`);
		if (del) { await p.click('[data-parity-del]'); await sleep(20); await record('delete'); } else out.delete = 'no-delete-control';
		await p.go('overview');
		const raw = await p.extract('#main');
		for (const k of raw.kpis) out[`overview.${k.label}`] = k.value;
		return out;
	},
};

/**
 * v5's Title / subject cell stacks up to four blocks (drawChron): the title, then the sender tag, the excerpt (always
 * ending in '…', S-chronology-3) and the 'also in: ' tag. Split them into their own columns so each is compared.
 */
function splitChronologyTitle(raw) {
	const t = raw.tables[0];
	const at = t?.header.findIndex((h) => /^Title/.test(h)) ?? -1;
	if (at < 0) return;
	t.header.splice(at + 1, 0, 'Sender', 'Excerpt', 'Also in');
	t.rows = t.rows.map((cells) => {
		const [title = '', ...rest] = cells[at] ?? [];
		const x = { sender: [], excerpt: [], also: [] };
		for (const part of rest) (part.startsWith('also in: ') ? x.also : part.endsWith('…') && !x.excerpt.length ? x.excerpt : x.sender).push(part.replace(/^also in: /, ''));
		return [...cells.slice(0, at), [title], x.sender, x.excerpt, x.also, ...cells.slice(at + 1)];
	});
}

export const SPECS = {
	overview: { sweeps: [overviewSeeded] },
	chronology: { key: 'ref', postRaw: splitChronologyTitle, sweeps: [chronologyUi, chronologyEngine] },
};
