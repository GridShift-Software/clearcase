// Snapshot flattening, value-by-value comparison, register classification and the counts-only scorecard. Pure: no
// browser, no files. tests/parity/compare.test.ts and tests/parity/mutations.test.ts cover it.
//
// A view snapshot (both sides return this shape; see docs/reference/parity/README.md):
//   { view, side: 'v5'|'app', status: 'ok'|'not-implemented'|'error', error?, owner?,
//     title?, texts: {id: s}, kpis: {id: {label, value, sub}}, counts: {id: s},
//     tables: {id: {columns: [{id, label}], key: colId|null, rows: [{colId: s}]}}, lists: {id: [s]},
//     controls: {inventoryId: n}, sweeps: {id: {combo: s}}, exports: {id: {name, columns?, rows?, text?}},
//     focus: {step: s} }
import { value as norm } from './normalize.mjs';
import { isDeepStrictEqual } from 'node:util';

export const ABSENT = '<absent>';

/** Every comparable value of a snapshot as path -> string. */
export function flatten(s) {
	const out = new Map();
	const put = (p, v) => { if (v !== undefined && v !== null) out.set(p, typeof v === 'string' ? v : String(v)); };
	put('title', s.title);
	for (const [k, v] of Object.entries(s.texts ?? {})) put(`text.${k}`, v);
	for (const [k, v] of Object.entries(s.kpis ?? {})) { put(`kpi.${k}.label`, v.label); put(`kpi.${k}.value`, v.value); if (v.sub !== undefined) put(`kpi.${k}.sub`, v.sub); }
	for (const [k, v] of Object.entries(s.counts ?? {})) put(`count.${k}`, v);
	for (const [k, t] of Object.entries(s.tables ?? {})) {
		put(`table.${k}.columns`, t.columns.map((c) => c.id).join(' | '));
		for (const c of t.columns) put(`table.${k}.col.${c.id}`, c.label);
		put(`table.${k}.rows`, t.rows.length);
		const seen = new Map();
		const keys = t.rows.map((r, i) => {
			if (!t.key) return String(i);
			const base = r[t.key] ?? '';
			const n = (seen.get(base) ?? 0) + 1;
			seen.set(base, n);
			return n > 1 ? `${base}#${n}` : base;
		});
		if (t.key) put(`table.${k}.order`, keys.join('\n'));
		t.rows.forEach((r, i) => { for (const c of t.columns) if (c.id !== t.key || !t.key) put(`table.${k}.row.${keys[i]}.${c.id}`, r[c.id] ?? ''); });
	}
	for (const [k, items] of Object.entries(s.lists ?? {})) { put(`list.${k}.count`, items.length); items.forEach((x, i) => put(`list.${k}.item.${i}`, x)); }
	for (const [k, n] of Object.entries(s.controls ?? {})) put(`control.${k}`, n);
	for (const [k, combos] of Object.entries(s.sweeps ?? {})) for (const [c, v] of Object.entries(combos)) put(`sweep.${k}.${c}`, v);
	for (const [k, e] of Object.entries(s.exports ?? {})) {
		put(`export.${k}.name`, e.name);
		if (e.text !== undefined) put(`export.${k}.text`, e.text);
		if (e.columns) put(`export.${k}.columns`, e.columns.join(' | '));
		if (e.rows) { put(`export.${k}.rows`, e.rows.length); e.rows.forEach((r, i) => r.forEach((c, j) => put(`export.${k}.row.${i}.${e.columns?.[j] ?? j}`, c))); }
	}
	for (const [k, v] of Object.entries(s.focus ?? {})) put(`focus.${k}`, v);
	return out;
}

/** First position where two newline-joined sequences differ, for readable order diffs. */
function firstDivergence(a, b) {
	const x = a.split('\n'), y = b.split('\n');
	let i = 0;
	while (i < x.length && i < y.length && x[i] === y[i]) i++;
	return { index: i, v5: x[i] ?? ABSENT, app: y[i] ?? ABSENT, v5Length: x.length, appLength: y.length };
}

/**
 * Compare two snapshots of one view. A path present on one side only is a difference ('<absent>' on the other).
 * Order paths compare whole sequences; their diff carries the first divergence.
 */
export function diff(v5, app) {
	// a view that does not extract, on either side, is never covered by the register: '!v5' means the reference itself
	// is missing, '!app' an adapter that threw or is missing for an available view; neither is an accepted absence
	if (v5.status === 'ok' && app.status === 'not-implemented') return { compared: 0, matched: 0, v5Values: flatten(v5).size, appValues: 0, diffs: [{ path: '*', kind: 'view-not-implemented', v5: 'view', app: ABSENT }] };
	if (v5.status !== 'ok') return { compared: 0, matched: 0, v5Values: 0, appValues: 0, diffs: [{ path: '!v5', kind: 'extract-error', v5: v5.error ?? v5.status, app: app.status }] };
	if (app.status !== 'ok') return { compared: 0, matched: 0, v5Values: v5.status === 'ok' ? flatten(v5).size : 0, appValues: app.status === 'ok' ? flatten(app).size : 0, diffs: [{ path: '!app', kind: 'extract-error', v5: v5.error ?? v5.status, app: app.error ?? app.status }] };
	const a = flatten(v5), b = flatten(app);
	const paths = new Set([...a.keys(), ...b.keys()]);
	const diffs = [];
	let matched = 0;
	for (const p of paths) {
		const x = a.has(p) ? norm(a.get(p)) : ABSENT;
		const y = b.has(p) ? (p.endsWith('.order') ? b.get(p) : norm(b.get(p))) : ABSENT;
		const xv = a.has(p) && p.endsWith('.order') ? a.get(p) : x;
		if (xv === y) { matched++; continue; }
		const kind = x === ABSENT ? 'app-only' : y === ABSENT ? 'v5-only' : p.endsWith('.order') ? 'order' : 'value';
		diffs.push(kind === 'order' ? { path: p, kind, ...firstDivergence(xv, y) } : { path: p, kind, v5: x, app: y });
	}
	return { compared: paths.size, matched, v5Values: a.size, appValues: b.size, diffs };
}

export const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
const valueMatches = (want, got) => want === undefined || (typeof want === 'string' ? want === got : new RegExp(want.re, 's').test(got));

/** The register entry that covers a difference, or null. Proposed (unapproved) entries apply unless approvedOnly. */
export function covering(entries, view, d, { approvedOnly = false } = {}) {
	for (const e of entries) {
		if (e.view !== view || d.kind === 'extract-error' || d.path.startsWith('!')) continue;
		if (approvedOnly && !e.approvedBy) continue;
		// a field of exactly the string '*' means the whole view is absent: it alone covers the app's view-not-implemented
		// difference, and covers nothing else (no other glob, '?', '**' or ['*'], stands for the whole view)
		if (d.path === '*' ? !(e.field === '*' && d.kind === 'view-not-implemented') : ![e.field].flat().some((f) => f !== '*' && globRe(f).test(d.path))) continue;
		if (e.when && !(valueMatches(e.when.v5, d.v5) && valueMatches(e.when.app, d.app))) continue;
		return e;
	}
	return null;
}

/** Compare a rendered list or table with its independent synthetic source, including order and extra elements. */
export function sourceMismatches(checks = []) {
	return checks.filter(({ rendered, source }) => !isDeepStrictEqual(rendered, source)).map(({ path }) => ({
		path, kind: 'source-mismatch', v5: 'synthetic source', app: 'rendered element',
	}));
}

/** Classify every difference of one view against the register. */
export function classify(view, result, entries, opts) {
	const registered = [], unregistered = [];
	for (const d of result.diffs) {
		const e = covering(entries, view, d, opts);
		if (e) registered.push({ ...d, register: e.id, type: e.type, approved: !!e.approvedBy });
		else unregistered.push(d);
	}
	unregistered.push(...sourceMismatches(opts?.sourceChecks));
	return { ...result, registered, unregistered };
}

export const TYPES = ['improvement', 'defect-fix', 'data-correction-deferred-to-pipeline', 'not-yet-implemented', 'known-gap'];

/** Counts-only scorecard: no paths, no values. Safe to commit or paste into a report. */
export function scorecard(perView, meta = {}) {
	const views = {};
	const total = { views: 0, viewsExtractedV5: 0, viewsComparedApp: 0, viewsNotImplemented: 0, viewsExtractError: 0, viewsFailed: 0, v5Values: 0, appValues: 0, compared: 0, matched: 0, registered: Object.fromEntries(TYPES.map((t) => [t, 0])), pendingApproval: 0, unregistered: 0 };
	for (const [view, r] of Object.entries(perView)) {
		const reg = Object.fromEntries(TYPES.map((t) => [t, 0]));
		for (const d of r.registered) reg[d.type]++;
		const pending = r.registered.filter((d) => !d.approved).length;
		const extractError = r.v5Status !== 'ok' || (r.appStatus !== 'ok' && r.appStatus !== 'not-implemented');
		const status = r.unregistered.length || extractError ? 'FAIL' : r.appStatus === 'not-implemented' ? 'NOT-YET-IMPLEMENTED' : r.registered.length ? 'PASS-with-notes' : 'PASS';
		views[view] = { status, v5: r.v5Status, app: r.appStatus, v5Values: r.v5Values, appValues: r.appValues, compared: r.compared, matched: r.matched, registered: reg, pendingApproval: pending, unregistered: r.unregistered.length, ms: r.ms ?? null };
		total.views++;
		if (r.v5Status === 'ok') total.viewsExtractedV5++;
		if (r.appStatus === 'ok') total.viewsComparedApp++;
		if (r.appStatus === 'not-implemented') total.viewsNotImplemented++;
		if (extractError) total.viewsExtractError++;
		if (status === 'FAIL') total.viewsFailed++;
		for (const k of ['v5Values', 'appValues', 'compared', 'matched']) total[k] += r[k];
		for (const t of TYPES) total.registered[t] += reg[t];
		total.pendingApproval += pending;
		total.unregistered += r.unregistered.length;
	}
	return { ...meta, result: total.unregistered || total.viewsExtractError ? 'FAIL' : 'PASS', total, views };
}

/**
 * Why a completed run fails (exit 1); empty when it passes. A view that did not extract on either side fails, as does
 * every unregistered difference. Every isolation breach fails: a v5 network request, an
 * app request that is not loopback, a canary hit other than a browser service, or a changed fixture tree. Browser-
 * internal viewer requests and browser-service canary hits are counted apart and do not fail.
 */
export function runFailures(sc, { views, unused = 0, strict = false }) {
	const t = sc.total, iso = sc.isolation ?? {};
	return [
		t.unregistered && `${t.unregistered} unregistered difference(s)`,
		t.viewsExtractedV5 !== views && `v5 extracted ${t.viewsExtractedV5} of ${views} view(s)`,
		t.viewsExtractError && `${t.viewsExtractError} view(s) with an extraction error`,
		strict && unused && `${unused} unused register entr${unused === 1 ? 'y' : 'ies'} (--strict-register)`,
		iso.v5NonFileRequests !== 0 && `v5 non-file requests ${iso.v5NonFileRequests}`,
		iso.appNonLoopbackRequests !== 0 && `app non-loopback requests ${iso.appNonLoopbackRequests}`,
		iso.canaryHits !== 0 && `canary hits ${iso.canaryHits}`,
		iso.fixtureUnchanged !== true && 'the fixture tree changed',
	].filter(Boolean);
}
