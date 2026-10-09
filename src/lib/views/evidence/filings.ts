// Filings & Affidavits (v5 filings_tab, L2610-2657): the imported filing groups and the filing <-> replying-affidavit
// register. Browser-safe and pure.
//
// The register combines two sources and never mixes them (S-seed-copy, S-filings_tab-1, corrected):
//  * imported seed rows (`filings.registerSeed`), which stay results. An edit or a deletion of a seed is a seed overlay
//    (GRS-10 viewSeeds: edited, conflict, orphaned), so a later results version still shows its own seed rows;
//  * rows the user adds, register rows in the user-work store `filings-register`, ordered by an explicit `seq`.
// The shown order is v5's insertion order: the seed rows in seed order, then the user's rows in the order added.
import { userCell, type Cell } from '../../components/csv.ts';

export const REGISTER_STORE = 'filings-register';
export const SEED_DATASET = 'filings';
/** v5's register fields, in its export order (L2656). */
export const FIELDS = ['filing', 'fdate', 'fparty', 'response', 'rdate', 'ref', 'status'] as const;
export type FilingField = (typeof FIELDS)[number];
export type FilingFields = Record<FilingField, string>;
/** The fields a user types (v5 has no status input: S-filings_tab-4, copied). */
export const INPUTS = ['filing', 'fdate', 'fparty', 'response', 'rdate', 'ref'] as const;

export interface FilingItem { ref: string; date: string; title: string; note: string; doc_type: string; text_status: string; url: string }
export interface FilingGroup { key: string; note: string; items: FilingItem[] }
export interface FilingsData { count?: number; groups: FilingGroup[]; registerSeed: FilingFields[] }

export type EntryState = 'seed' | 'edited' | 'conflict' | 'orphaned' | 'user';
export interface RegisterEntry {
	/** stable key: `seed:<seed id>` or `row:<row id>`, never a position */
	key: string;
	state: EntryState;
	fields: FilingFields;
	/** the imported seed as it is now, when the user's edit was made against an older one (conflict) */
	imported: FilingFields | null;
	/** whether the user's values (not imported ones) are shown: they are user-entered in an export */
	userEntered: boolean;
	/** a deletion of the seed that has changed since (shown so the user can confirm or keep it) */
	deletedEarlier: boolean;
	/** the seed content digest an overlay is made against (seed rows only) */
	seedSha256: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
export const asFields = (o: Readonly<Record<string, unknown>>): FilingFields => Object.fromEntries(FIELDS.map((k) => [k, str(o[k])])) as FilingFields;

/** One GRS-10 seed view, reduced to what the register needs (plain data, so it travels to the page). */
export type SeedViewLike =
	| { state: 'seed'; seed: { seedId: string; seedSha256: string; record: Readonly<Record<string, unknown>> } }
	| { state: 'edited' | 'conflict'; seed: { seedId: string; seedSha256: string; record: Readonly<Record<string, unknown>> }; overlay: { fields: Record<string, unknown> } }
	| { state: 'orphaned'; overlay: { seedId: string; fields: Record<string, unknown> } };
export interface UserRowLike { rowId: string; fields: Record<string, unknown> }

/** The register as shown: seeds (minus the user's deletions) in seed order, orphaned edits, then user rows by seq. */
export function registerEntries(seeds: readonly SeedViewLike[], rows: readonly UserRowLike[]): RegisterEntry[] {
	const out: RegisterEntry[] = [];
	for (const v of seeds) {
		if (v.state === 'seed') { out.push({ key: `seed:${v.seed.seedId}`, state: 'seed', fields: asFields(v.seed.record), imported: null, userEntered: false, deletedEarlier: false, seedSha256: v.seed.seedSha256 }); continue; }
		if (v.state === 'orphaned') {
			if (v.overlay.fields.deleted === true) continue;
			out.push({ key: `seed:${v.overlay.seedId}`, state: 'orphaned', fields: asFields(v.overlay.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: null });
			continue;
		}
		const deleted = v.overlay.fields.deleted === true;
		if (v.state === 'edited') {
			if (deleted) continue;
			out.push({ key: `seed:${v.seed.seedId}`, state: 'edited', fields: asFields(v.overlay.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: v.seed.seedSha256 });
		} else if (deleted) {
			// deleted against an older seed: the imported row changed since, so it is shown again with that note
			out.push({ key: `seed:${v.seed.seedId}`, state: 'conflict', fields: asFields(v.seed.record), imported: null, userEntered: false, deletedEarlier: true, seedSha256: v.seed.seedSha256 });
		} else {
			out.push({ key: `seed:${v.seed.seedId}`, state: 'conflict', fields: asFields(v.overlay.fields), imported: asFields(v.seed.record), userEntered: true, deletedEarlier: false, seedSha256: v.seed.seedSha256 });
		}
	}
	const seq = (r: UserRowLike) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER);
	for (const r of [...rows].sort((a, b) => seq(a) - seq(b) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0)))
		out.push({ key: `row:${r.rowId}`, state: 'user', fields: asFields(r.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: null });
	return out;
}

/** The next `seq` for a new user row: one more than the largest stored. */
export const nextSeq = (rows: readonly UserRowLike[]) => rows.reduce((m, r) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) && r.fields.seq > m ? r.fields.seq : m), 0) + 1;

/** The typed fields of an add or edit form. v5 ignores an Add without a Filing (L2650); so does the app. */
export function formFields(get: (k: string) => unknown): { values: Record<(typeof INPUTS)[number], string>; ok: boolean } {
	const values = Object.fromEntries(INPUTS.map((k) => [k, str(get(k))])) as Record<(typeof INPUTS)[number], string>;
	return { values, ok: values.filing.trim() !== '' };
}

/** v5 ess_dcs_filing_register.csv: imported seed values unchanged, user-entered values neutralised (S-csv). */
export function registerCsvRows(entries: readonly RegisterEntry[]): Cell[][] {
	return [[...FIELDS], ...entries.map((e) => FIELDS.map((k) => (e.userEntered ? userCell(e.fields[k]) : e.fields[k])))];
}

/** v5 ess_dcs_filings.csv (L2653-2655): every group item, imported values unchanged. */
export function filingsCsvRows(groups: readonly FilingGroup[]): Cell[][] {
	const head = ['group', 'ref', 'date', 'title', 'note', 'doc_type', 'text_status', 'url'];
	return [head, ...groups.flatMap((g) => g.items.map((x) => [g.key, x.ref, x.date, x.title, x.note, x.doc_type, x.text_status, x.url]))];
}

/** The note shown for a register row that is not plainly an imported or a user row (overlay states). */
export function entryNote(e: RegisterEntry): string | null {
	if (e.deletedEarlier) return 'You deleted this imported row before it changed in this results version; delete it again to confirm.';
	if (e.state === 'conflict' && e.imported) return `Your edit of an imported row that has changed since. Imported now: ${FIELDS.filter((k) => e.imported![k]).map((k) => e.imported![k]).join(' · ')}`;
	if (e.state === 'orphaned') return 'Your edit of an imported row that is not in this results version.';
	return null;
}
