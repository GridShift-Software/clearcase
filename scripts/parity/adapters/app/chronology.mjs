// App adapter: Chronology (the pilot's view, GRS-12). The grid is read cell by cell from the rendered rows; the
// Title / subject cell is split like v5's (title, sender, excerpt, also in), the Original column takes v5's Doc id, and the ref cell's "in <parent>" note becomes its own column. Sweeps drive the same filters and sorts.
import { join } from 'node:path';
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { SORTS, engineCombos, seqValue, uiCombos } from '../../lib/sweeps.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

const ROUTE = '/chronology';
const COLUMN = { date: 'date', 'date basis': 'date_basis', ref: 'ref', 'title / subject': 'title_subject', type: 'type', bundle: 'bundle', amount: 'amount', status: 'status', original: 'doc' };

/** Every rendered row: cell texts by column, with the title and ref cells split into their parts. */
const readGrid = (p) => p.evaluate(`(() => {
	const g = document.querySelector('#main [role=table]');
	const head = [...g.querySelectorAll('[role=columnheader]')].map((h) => h.textContent.replace(/\\s*[▲▼]\\s*$/, '').replace(/\\s+/g, ' ').trim());
	const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim();
	const rows = [...g.querySelectorAll('[role=row][data-ref]')].map((r) => {
		const cells = [...r.querySelectorAll('[role=cell]')];
		const o = {};
		head.forEach((h, i) => {
			const c = cells[i];
			if (/^Title/.test(h)) { const clip = c.querySelector('.clip'); const small = clip?.querySelector('small'); o[h] = [...(clip?.childNodes ?? [])].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && n !== small)).map((n) => n.textContent).join('').replace(/\\s+/g, ' ').trim(); o.Sender = t(small).replace(/^—\\s*/, ''); o.Excerpt = t(c.querySelector('.excerpt')); o.Also = t(c.querySelector('.also-in')).replace(/^also in:\\s*/, ''); }
			else if (h === 'Ref') { const small = c.querySelector('small'); o.Ref = t(c.querySelector('a')); o.Parent = t(small).replace(/^in\\s+/, ''); }
			else o[h] = t(c);
		});
		return o;
	});
	const sorted = [...g.querySelectorAll('[role=columnheader][aria-sort]')].map((h) => h.textContent.replace(/\\s*[▲▼]\\s*$/, '').trim() + ' ' + (h.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc'))[0] ?? null;
	return { head, rows, sorted, count: document.getElementById('row-count')?.dataset.count ?? null };
})()`);

/** Columns read from a part of another cell (the split Title / subject cell and the ref cell's parent note). */
const PART = { sender: 'Sender', excerpt: 'Excerpt', also_in: 'Also', parent: 'Parent' };

const APP_SORT_LABEL = { date: 'Date', ref: 'Ref', docType: 'Type', bundle: 'Bundle', amount: 'Amount' };

/** Click a sort button until its column reports the wanted aria-sort (at most three clicks). */
async function appSort(p, k, d) {
	const want = d === 1 ? 'ascending' : 'descending';
	for (let i = 0; i < 3; i++) {
		const cur = await p.evaluate(`document.getElementById('sort-${k}')?.closest('[role=columnheader]')?.getAttribute('aria-sort') ?? null`);
		if (cur === want) return true;
		if (!(await p.click(`#sort-${k}`))) return false;
		await p.settled();
	}
	return false;
}

export default {
	view: 'chronology',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: 'chronology' });
		await open(p, ctx, ROUTE, 'chronology');
		const raw = await p.extract('#main', { exclude: '[role=table]' });
		const s = fromRaw('chronology', 'app', raw);
		const grid = await readGrid(p);
		const hasParent = grid.rows.some((r) => r.Parent);
		const columns = [];
		for (const h of grid.head) {
			const id = COLUMN[h.toLowerCase()] ?? h.toLowerCase();
			columns.push({ id, label: h });
			if (id === 'title_subject') columns.push({ id: 'sender', label: 'Sender' }, { id: 'excerpt', label: 'Excerpt' }, { id: 'also_in', label: 'Also in' });
			if (id === 'ref' && hasParent) columns.push({ id: 'parent', label: 'Parent' });
		}
		const byLabel = Object.fromEntries(columns.map((c) => [c.id, c.label]));
		s.tables = { table_1: { columns, key: 'ref', rows: grid.rows.map((r) => Object.fromEntries(columns.map((c) => [c.id, PART[c.id] ? r[PART[c.id]] : r[byLabel[c.id]] ?? '']))) } };
		delete s.texts['chronology.sorted'];
		if (grid.sorted) s.texts['table_1.sorted'] = `${COLUMN[grid.sorted.split(' ').slice(0, -1).join(' ').toLowerCase()]} ${grid.sorted.split(' ').pop()}`;
		s.counts['table_1.total'] = grid.count;
		// the grid's own controls: sort buttons as sort headers, and the per-row links by column
		const ctl = await p.extract('#main [role=table]');
		for (const c of ctl.controls) {
			const id = c.inRow ? `row:${c.kind}:${c.column}` : `${c.kind}:${c.label.replace(/\s*[▲▼]\s*$/, '')}`;
			s.controls[id] = c.inRow ? 1 : (s.controls[id] ?? 0) + 1;
		}
		if (ctx.exports) {
			const got = await pressAndCapture(p, '#export-csv', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		/** Filters and sorts through the app's own controls, one fresh load per combination. */
		async filter_sort_ui(p, ctx) {
			const out = {};
			for (const c of uiCombos(ctx.dims).slice(0, Number(process.env.PARITY_MAX_COMBOS) || undefined)) {
				const tc = performance.now();
				await open(p, ctx, ROUTE, 'chronology');
				const q = ctx.dims.queries[c.q];
				if (q) { await p.type('#f-q', q); await p.settled(); }
				let refused = null;
				for (const [sel, v] of [['#f-bundle', ctx.dims.bundles[c.b]], ['#f-type', ctx.dims.types[c.t]], ['#f-status', ctx.dims.statuses[c.s]]]) {
					if (!v) continue;
					const r = await p.select(sel, v);
					if (r !== 'ok') { refused = r; break; }
					await p.settled();
				}
				if (refused) { out[c.key] = refused; continue; }
				if (!(await appSort(p, SORTS[c.k], c.d))) { out[c.key] = 'no-sort-control'; continue; }
				await sleep(5);
				await p.settled();
				const g = await p.evaluate(`({ refs: [...document.querySelectorAll('#main [role=row][data-ref]')].map((r) => r.dataset.ref), count: document.getElementById('row-count')?.dataset.count })`);
				out[c.key] = `${seqValue(g.refs)}|shown ${g.count}`;
				if (process.env.PARITY_TRACE) console.error(`app ui ${c.key} ${Math.round(performance.now() - tc)} ms`);
			}
			return out;
		},
		/** Library level: the app's own query module over the rows its API serves to the chronology page. */
		async filter_sort_engine(p, ctx) {
			const { queryRows } = await import(join(ctx.appRoot, 'src', 'lib', 'local-case', 'chronology.ts'));
			await open(p, ctx, ROUTE, 'chronology');
			const rows = await p.evaluate(`fetch(${JSON.stringify(`/api/v/${encodeURIComponent(ctx.vid)}/chronology`)}).then((r) => r.json())`);
			const out = {};
			for (const c of engineCombos(ctx.dims)) {
				const refs = queryRows(rows, { q: ctx.dims.queries[c.q], bundle: ctx.dims.bundles[c.b], type: ctx.dims.types[c.t], status: ctx.dims.statuses[c.s], sort: SORTS[c.k], dir: c.d }).map((r) => r.ref);
				out[c.key] = seqValue(refs);
			}
			return out;
		},
	},
};
