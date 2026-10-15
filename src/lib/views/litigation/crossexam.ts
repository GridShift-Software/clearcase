import type { SeedView } from '../../case-package/browser.ts';

export const CX_FIELDS = ['witness', 'topic', 'put', 'docs'] as const;
export type CxField = (typeof CX_FIELDS)[number];
export type CxValues = Record<CxField, string>;

export interface CxRow extends CxValues {
	key: string;
	kind: 'seed' | 'edited' | 'conflict' | 'orphaned' | 'user';
	target: { seedId: string } | { rowId: string };
	authored: boolean;
	note: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const valuesOf = (o: Readonly<Record<string, unknown>>): CxValues => ({ witness: str(o.witness), topic: str(o.topic), put: str(o.put), docs: str(o.docs) });
const over = (base: CxValues, f: Readonly<Record<string, unknown>>): CxValues => Object.fromEntries(CX_FIELDS.map((k) => [k, Object.hasOwn(f, k) ? str(f[k]) : base[k]])) as CxValues;
export const isDeleted = (f: Readonly<Record<string, unknown>>) => f.deleted === true;

export function crossexamRows(views: readonly SeedView[], user: readonly { rowId: string; fields: Readonly<Record<string, unknown>> }[]): CxRow[] {
	const out: CxRow[] = [];
	for (const v of views) {
		if (v.state === 'seed') { out.push({ key: `seed:${v.seed.seedId}`, kind: 'seed', target: { seedId: v.seed.seedId }, authored: true, note: null, ...valuesOf(v.seed.record) }); continue; }
		if (v.state === 'orphaned') {
			if (isDeleted(v.overlay.fields)) continue;
			out.push({ key: `orphan:${v.overlay.seedId}`, kind: 'orphaned', target: { seedId: v.overlay.seedId }, authored: false, note: 'Your edit of an imported topic that is not in this results version; it is kept.', ...over({ witness: '', topic: '', put: '', docs: '' }, v.overlay.fields) });
			continue;
		}
		const seed = valuesOf(v.seed.record);
		if (v.state === 'edited') {
			if (isDeleted(v.overlay.fields)) continue;
			out.push({ key: `seed:${v.seed.seedId}`, kind: 'edited', target: { seedId: v.seed.seedId }, authored: false, note: null, ...over(seed, v.overlay.fields) });
			continue;
		}
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

export const canAddCx = (v: CxValues) => !!(v.witness || v.topic);

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
