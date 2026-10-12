// Cross-Exam Prep (crossexam_tab): the package's seed topics (`lit-crossexam-seed`, read through seedViews, never
// copied: S-crossexam_tab-1, S-seed-copy) first in data order, then the user's own topics (register store
// `crossexam`, by `seq`). A seed the user deleted is an overlay `{deleted: true}`; an overlay made against an
// earlier seed is a conflict and an overlay whose seed is gone is orphaned, and both stay visible. Browser-safe.
import type { SeedView } from '../../case-package/browser.ts';

export const CX_FIELDS = ['witness', 'topic', 'put', 'docs'] as const;
export type CxField = (typeof CX_FIELDS)[number];
export type CxValues = Record<CxField, string>;

export interface CxRow extends CxValues {
	/** stable display key */
	key: string;
	/** seed: imported as is; edited: an overlay over the current seed; conflict: the seed changed since the user's
	 *  overlay; orphaned: the overlay's seed is not in this version; user: the user's own topic */
	kind: 'seed' | 'edited' | 'conflict' | 'orphaned' | 'user';
	/** what the Delete button removes: a seed (by seed id) or a user row (by row id) */
	target: { seedId: string } | { rowId: string };
	/** authored text from the package (rendered as narrative) rather than text the user typed */
	authored: boolean;
	/** a disclosure shown with the row (conflict, orphaned), or null */
	note: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const valuesOf = (o: Readonly<Record<string, unknown>>): CxValues => ({ witness: str(o.witness), topic: str(o.topic), put: str(o.put), docs: str(o.docs) });
/** An overlay's fields over the seed's: only the four register fields, each only when the overlay has it. */
const over = (base: CxValues, f: Readonly<Record<string, unknown>>): CxValues => Object.fromEntries(CX_FIELDS.map((k) => [k, Object.hasOwn(f, k) ? str(f[k]) : base[k]])) as CxValues;
export const isDeleted = (f: Readonly<Record<string, unknown>>) => f.deleted === true;

/** The rows the view shows, in order: seeds (data order) with their overlays, orphaned overlays, then user rows. */
export function crossexamRows(views: readonly SeedView[], user: readonly { rowId: string; fields: Readonly<Record<string, unknown>> }[]): CxRow[] {
	const out: CxRow[] = [];
	for (const v of views) {
		if (v.state === 'seed') { out.push({ key: `seed:${v.seed.seedId}`, kind: 'seed', target: { seedId: v.seed.seedId }, authored: true, note: null, ...valuesOf(v.seed.record) }); continue; }
		if (v.state === 'orphaned') {
			if (isDeleted(v.overlay.fields)) continue; // the user deleted a seed that this version no longer has
			out.push({ key: `orphan:${v.overlay.seedId}`, kind: 'orphaned', target: { seedId: v.overlay.seedId }, authored: false, note: 'Your edit of an imported topic that is not in this results version; it is kept.', ...over({ witness: '', topic: '', put: '', docs: '' }, v.overlay.fields) });
			continue;
		}
		const seed = valuesOf(v.seed.record);
		if (v.state === 'edited') {
			if (isDeleted(v.overlay.fields)) continue;
			out.push({ key: `seed:${v.seed.seedId}`, kind: 'edited', target: { seedId: v.seed.seedId }, authored: false, note: null, ...over(seed, v.overlay.fields) });
			continue;
		}
		// conflict: the imported topic changed since the user's overlay was made; show the current seed and the overlay
		if (isDeleted(v.overlay.fields)) {
			out.push({ key: `seed:${v.seed.seedId}`, kind: 'conflict', target: { seedId: v.seed.seedId }, authored: true, note: 'You deleted an earlier version of this imported topic; it has changed since, so it is shown again.', ...seed });
			continue;
		}
		out.push({ key: `seed:${v.seed.seedId}`, kind: 'seed', target: { seedId: v.seed.seedId }, authored: true, note: 'This imported topic changed after you edited it; your edit follows.', ...seed });
		out.push({ key: `edit:${v.seed.seedId}`, kind: 'conflict', target: { seedId: v.seed.seedId }, authored: false, note: 'Your edit, made against an earlier version of the topic above.', ...over(seed, v.overlay.fields) });
	}
	for (const r of user) out.push({ key: `row:${r.rowId}`, kind: 'user', target: { rowId: r.rowId }, authored: false, note: null, ...valuesOf(r.fields) });
	return out;
}

/** v5's add rule (addCx): a topic needs a witness or a topic; otherwise nothing is added. */
export const canAddCx = (v: CxValues) => !!(v.witness || v.topic);

/**
 * How v5's `ess_dcs_crossexam_v1` (the seed copied into storage, then the user's edits) would map onto this design,
 * for a later import (none is built in V1). A stored row whose natural key (witness, topic) names a seed of the same
 * results version becomes an overlay when its fields differ and nothing when they are equal; every other stored row
 * becomes a user row in stored order; a seed missing from the stored array becomes a `{deleted: true}` overlay.
 */
export function mapV5Crossexam(seeds: readonly { seedId: string; record: Readonly<Record<string, unknown>> }[], stored: readonly Readonly<Record<string, unknown>>[]) {
	const keyOf = (o: Readonly<Record<string, unknown>>) => JSON.stringify([str(o.witness), str(o.topic)]);
	const byKey = new Map(seeds.map((s) => [keyOf(s.record), s]));
	const seen = new Set<string>();
	const overlays: { seedId: string; fields: Record<string, unknown> }[] = [];
	const userRows: CxValues[] = [];
	for (const row of stored) {
		const s = byKey.get(keyOf(row));
		if (s && !seen.has(s.seedId)) {
			seen.add(s.seedId);
			const a = valuesOf(s.record), b = valuesOf(row);
			if (CX_FIELDS.some((k) => a[k] !== b[k])) overlays.push({ seedId: s.seedId, fields: { ...b } });
		} else userRows.push(valuesOf(row));
	}
	for (const s of seeds) if (!seen.has(s.seedId)) overlays.push({ seedId: s.seedId, fields: { deleted: true } });
	return { overlays, userRows };
}
