// Build a view snapshot from the raw extractor output (scripts/parity/lib/dom.mjs). The v5 side uses `fromRaw` for
// every view; an app adapter can use it too and then rename ids with `remap`, or build its snapshot by hand.
// Ids are slugs of the v5 wording, so an app adapter maps its own elements onto the v5 ids.
import { inventory, slug, ws } from './normalize.mjs';

const ARROW = /\s*[▲▼↑↓]\s*$/u;
export const stripArrow = (s) => ws(s).replace(ARROW, '');
const uniq = (obj, id) => { let k = id, i = 2; while (Object.hasOwn(obj, k)) k = `${id}_${i++}`; return k; };

export const emptySnapshot = (view, side, status = 'ok') => ({ view, side, status, title: undefined, texts: {}, kpis: {}, counts: {}, tables: {}, lists: {}, controls: {}, sweeps: {}, exports: {}, focus: {} });

/**
 * The app side of a view without an app adapter: not implemented when the view registry says so, else an extraction
 * error (the registry marks it available, so a missing adapter is a harness gap, never an accepted absence).
 */
export function appWithoutAdapter(view, registry) {
	if (registry[view]?.status === 'available') return { ...emptySnapshot(view, 'app', 'error'), error: `the registry marks ${view} available but no app adapter exists (scripts/parity/adapters/app/${view}.mjs)` };
	return { ...emptySnapshot(view, 'app', 'not-implemented'), owner: registry[view]?.linear ?? null };
}

/**
 * The app side of a view with an app adapter, as the runner scores it: for a view the registry marks available, any
 * status other than 'ok' is an extraction error (an adapter cannot declare an available view not implemented and so
 * fall under a whole-view waiver); otherwise the adapter's snapshot as returned.
 */
export function appFromAdapter(view, registry, sa) {
	if (registry[view]?.status !== 'available' || sa?.status === 'ok' || sa?.status === 'error') return sa;
	return { ...emptySnapshot(view, 'app', 'error'), error: `the registry marks ${view} available but its app adapter returned status ${JSON.stringify(sa?.status)}` };
}

/** A table from raw: columns are slugs of the header labels (sort arrows removed), cells are parts joined ' / '. */
export function tableFromRaw(t, { key = 'ref' } = {}) {
	const columns = [];
	for (const h of t.header) { const label = stripArrow(h); columns.push({ id: uniq(Object.fromEntries(columns.map((c) => [c.id, 1])), slug(label)), label }); }
	const rows = t.rows.map((cells) => Object.fromEntries(columns.map((c, j) => [c.id, (cells[j] ?? []).join(' / ')])));
	const sorted = t.header.map((h, j) => (ARROW.test(ws(h)) ? `${columns[j].id} ${/[▲↑]/u.test(h) ? 'asc' : 'desc'}` : null)).find(Boolean) ?? null;
	return { columns, key: columns.some((c) => c.id === key) ? key : null, rows, sorted };
}

export function fromRaw(view, side, raw, { tableKey = 'ref' } = {}) {
	const s = emptySnapshot(view, side);
	s.title = raw.h1[0] ?? '';
	for (const k of raw.kpis) s.kpis[uniq(s.kpis, slug(k.label))] = { label: k.label, value: k.value, sub: k.sub };
	raw.tables.forEach((t, i) => {
		const id = uniq(s.tables, t.caption ? slug(t.caption) : `table_${i + 1}`);
		const { sorted, ...tab } = tableFromRaw(t, { key: tableKey });
		s.tables[id] = tab;
		if (sorted) s.texts[`${id}.sorted`] = sorted;
	});
	const n = {};
	for (const p of raw.paragraphs) {
		const sec = /\bmeta\b|\bsubtitle\b/.test(p.cls) ? 'subtitle' : /\bpager\b/.test(p.cls) ? 'pager' : slug(p.section || 'page');
		n[sec] = (n[sec] ?? 0) + 1;
		s.texts[n[sec] > 1 || sec !== 'subtitle' ? `${sec}.${n[sec]}` : sec] = p.text;
	}
	raw.lists.forEach((l, i) => { s.lists[uniq(s.lists, l.caption ? slug(l.caption) : `list_${i + 1}`)] = l.items; });
	const top = raw.controls.filter((c) => !c.inRow);
	s.controls = inventory(top);
	for (const c of raw.controls.filter((c) => c.inRow)) s.controls[`row:${c.kind}:${c.column || '?'}`] = 1;
	for (const c of top) if (c.options) s.lists[uniq(s.lists, `select.${slug(c.label)}`)] = c.options;
	return s;
}

/**
 * Rename snapshot ids: map is { 'kpi.<appId>': '<v5Id>', 'table.<appId>': '<v5Id>', 'text.<appId>': ..., ... }.
 * There is no way to drop an id: app content without a v5 counterpart stays in the snapshot and shows as app-only.
 */
export function remap(s, map) {
	const out = { ...s };
	for (const [section, prefix] of [['texts', 'text'], ['kpis', 'kpi'], ['counts', 'count'], ['tables', 'table'], ['lists', 'list'], ['controls', 'control'], ['exports', 'export']]) {
		out[section] = {};
		for (const [k, v] of Object.entries(s[section] ?? {})) {
			const to = map[`${prefix}.${k}`] ?? k;
			if (Object.hasOwn(out[section], to)) throw new Error(`remap: two ${prefix} ids map to ${to}`);
			out[section][to] = v;
		}
	}
	return out;
}
