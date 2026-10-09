// Parameterized interaction sweeps shared by both sides: the combination designs (index-coded keys, so no case value
// ever appears in a key), the sequence digest and the synthetic user work. Pure.

/** FNV-1a plus djb2 over a string, as the parity trial used; also injected into the v5 page for the engine sweep. */
export const FNV_SRC = `(s) => { let h = 0x811c9dc5, g = 5381; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h ^= c; h = Math.imul(h, 0x01000193) >>> 0; g = (Math.imul(g, 33) + c) >>> 0; } return h.toString(16) + ':' + g.toString(16); }`;
export const fnv = (0, eval)(FNV_SRC);
/** A shown sequence as one comparable value: its length and digest. */
export const seqValue = (keys) => `${keys.length}|${fnv(keys.join('\n'))}`;

export const SORTS = ['date', 'ref', 'docType', 'bundle', 'amount'];
/** Free-text filters: generic probes (substring, punctuation, case, white space only), no case wording. */
export const QUERIES = ['', 'pdf', 'e', 'RE:', '  '];
export const STATUSES = ['', 'extracted', 'ocr', 'none', 'pending'];

/**
 * Filter dimensions from the package's chronology rows (the shared input of both sides): bundle and type options are
 * the sorted distinct values, with '' (all) first. Statuses are the v5 option list plus any other value in the data.
 */
export function chronologyDims(rows) {
	const distinct = (k) => [...new Set(rows.map((r) => r[k] ?? ''))].sort();
	return { bundles: ['', ...distinct('bundle')], types: ['', ...distinct('doc_type')], statuses: [...new Set([...STATUSES, ...distinct('text_status')])], queries: QUERIES, sorts: SORTS };
}

const key = (c) => `b${c.b}.t${c.t}.s${c.s}.q${c.q}.${SORTS[c.k]}.${c.d === 1 ? 'asc' : 'desc'}`;

/**
 * The UI sweep's covering design (about a hundred combinations): every bundle with every sort in both directions,
 * every type, every status, every query under three sorts, and each bundle with the first three types.
 */
export function uiCombos(dims) {
	const out = new Map();
	const add = (c) => { const x = { b: 0, t: 0, s: 0, q: 0, k: 0, d: 1, ...c }; out.set(key(x), x); };
	for (let b = 0; b < dims.bundles.length; b++) for (let k = 0; k < SORTS.length; k++) for (const d of [1, -1]) add({ b, k, d });
	for (let t = 1; t < dims.types.length; t++) add({ t });
	for (let s = 1; s < dims.statuses.length; s++) add({ s });
	for (let q = 1; q < dims.queries.length; q++) for (const [k, d] of [[0, 1], [1, -1], [4, -1]]) add({ q, k, d });
	for (let b = 1; b < dims.bundles.length; b++) for (let t = 1; t <= Math.min(3, dims.types.length - 1); t++) add({ b, t });
	return [...out].map(([k, c]) => ({ key: k, ...c }));
}

/** The engine sweep's full grid (the parity trial's 22,500 shape): bundles x types x statuses x queries x sorts x dirs. */
export function engineCombos(dims) {
	const out = [];
	for (let b = 0; b < dims.bundles.length; b++) for (let t = 0; t < dims.types.length; t++) for (let s = 0; s < dims.statuses.length; s++)
		for (let q = 0; q < dims.queries.length; q++) for (let k = 0; k < SORTS.length; k++) for (const d of [1, -1]) { const c = { b, t, s, q, k, d }; out.push({ key: key(c), ...c }); }
	return out;
}

const day = (clock, offset) => new Date(Date.parse(clock) + offset * 86400000).toISOString().slice(0, 10);
/**
 * Synthetic user work, relative to the run clock (view checklist examples): deadlines yesterday, today, tomorrow and
 * in 30 days; timesheet rows blank-billed, 'no' and 'yes' (S-overview-1). No case wording.
 */
export const seededUserWork = (clock) => ({
	ess_dcs_deadlines_v1: [
		{ title: 'Synthetic deadline A', date: day(clock, -1), cat: 'Filing', note: 'synthetic' },
		{ title: 'Synthetic deadline B', date: day(clock, 0), cat: 'Hearing', note: '' },
		{ title: 'Synthetic deadline C', date: day(clock, 1), cat: 'Other', note: 'synthetic' },
		{ title: 'Synthetic deadline D', date: day(clock, 30), cat: 'Payment', note: '' },
	],
	ess_dcs_timesheet_v1: [
		{ date: day(clock, -3), fee_earner: 'Synthetic earner', activity: 'Synthetic activity 1', hours: '2.5', rate: '1000', billed: '' },
		{ date: day(clock, -2), fee_earner: 'Synthetic earner', activity: 'Synthetic activity 2', hours: '1', rate: '1000', billed: 'no' },
		{ date: day(clock, -1), fee_earner: 'Synthetic earner', activity: 'Synthetic activity 3', hours: '4', rate: '1000', billed: 'yes' },
	],
});

/** A synthetic value for a form field of the given input type (register edit sequences). */
export function syntheticInput(type, n, clock) {
	if (type === 'date') return day(clock, 3 + n);
	if (type === 'number') return String(1.5 + n);
	return `Synthetic entry ${n + 1}`;
}
