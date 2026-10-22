import { userCell, type Cell } from '../../components/csv.ts';

export const REGISTER_STORE = 'filings-register';
export const SEED_DATASET = 'filings';
export const FIELDS = ['filing', 'fdate', 'fparty', 'response', 'rdate', 'ref', 'status'] as const;
export type FilingField = (typeof FIELDS)[number];
export type FilingFields = Record<FilingField, string>;
/** The legacy v5 fields; the app also accepts a status for user work. */
export const INPUTS = ['filing', 'fdate', 'fparty', 'response', 'rdate', 'ref'] as const;
export const FORM_INPUTS = [...INPUTS, 'status'] as const;

export interface FilingItem { ref: string; date: string; title: string; note: string; doc_type: string; text_status: string; url: string }
export interface FilingGroup { key: string; note: string; items: FilingItem[] }
export interface FilingsData { count?: number; groups: FilingGroup[]; registerSeed: FilingFields[] }

export type EntryState = 'seed' | 'edited' | 'conflict' | 'orphaned' | 'user';
export interface RegisterEntry {
	key: string;
	state: EntryState;
	fields: FilingFields;
	imported: FilingFields | null;
	userEntered: boolean;
	deletedEarlier: boolean;
	seedSha256: string | null;
	seed: FilingFields | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
export const asFields = (o: Readonly<Record<string, unknown>>): FilingFields => Object.fromEntries(FIELDS.map((k) => [k, str(o[k])])) as FilingFields;

export type SeedViewLike =
	| { state: 'seed'; seed: { seedId: string; seedSha256: string; record: Readonly<Record<string, unknown>> } }
	| { state: 'edited' | 'conflict'; seed: { seedId: string; seedSha256: string; record: Readonly<Record<string, unknown>> }; overlay: { fields: Record<string, unknown> } }
	| { state: 'orphaned'; overlay: { seedId: string; fields: Record<string, unknown> } };
export interface UserRowLike { rowId: string; fields: Record<string, unknown> }

export function registerEntries(seeds: readonly SeedViewLike[], rows: readonly UserRowLike[]): RegisterEntry[] {
	const out: RegisterEntry[] = [];
	for (const v of seeds) {
		if (v.state === 'seed') { out.push({ key: `seed:${v.seed.seedId}`, state: 'seed', fields: asFields(v.seed.record), imported: null, userEntered: false, deletedEarlier: false, seedSha256: v.seed.seedSha256, seed: asFields(v.seed.record) }); continue; }
		if (v.state === 'orphaned') {
			if (v.overlay.fields.deleted === true) continue;
			out.push({ key: `seed:${v.overlay.seedId}`, state: 'orphaned', fields: asFields(v.overlay.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: null, seed: null });
			continue;
		}
		const deleted = v.overlay.fields.deleted === true;
		const seed = asFields(v.seed.record);
		if (v.state === 'edited') {
			if (deleted) continue;
			out.push({ key: `seed:${v.seed.seedId}`, state: 'edited', fields: asFields(v.overlay.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: v.seed.seedSha256, seed });
		} else if (deleted) {
			out.push({ key: `seed:${v.seed.seedId}`, state: 'conflict', fields: seed, imported: null, userEntered: false, deletedEarlier: true, seedSha256: v.seed.seedSha256, seed });
		} else {
			out.push({ key: `seed:${v.seed.seedId}`, state: 'conflict', fields: asFields(v.overlay.fields), imported: seed, userEntered: true, deletedEarlier: false, seedSha256: v.seed.seedSha256, seed });
		}
	}
	const seq = (r: UserRowLike) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER);
	for (const r of [...rows].sort((a, b) => seq(a) - seq(b) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0)))
		out.push({ key: `row:${r.rowId}`, state: 'user', fields: asFields(r.fields), imported: null, userEntered: true, deletedEarlier: false, seedSha256: null, seed: null });
	return out;
}

export const nextSeq = (rows: readonly UserRowLike[]) => rows.reduce((m, r) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) && r.fields.seq > m ? r.fields.seq : m), 0) + 1;

/**
 * The typed fields of an add or edit form. v5 refuses an Add whose Filing is empty (L2650) but adds one of spaces,
 * untrimmed; so does the app, on Add and on Edit.
 */
export function formFields(get: (k: string) => unknown): { values: Record<(typeof INPUTS)[number], string>; ok: boolean } {
	const values = Object.fromEntries(INPUTS.map((k) => [k, str(get(k))])) as Record<(typeof INPUTS)[number], string>;
	return { values, ok: values.filing !== '' };
}
export function formEntryFields(get: (k: string) => unknown) {
	const { values, ok } = formFields(get);
	const status = get('status');
	return { values: { ...values, status: str(status) }, statusProvided: status !== null && status !== undefined, ok };
}

export type SaveFailure = 'busy' | 'empty-add' | 'empty-edit' | 'gone' | 'stale' | 'version' | 'lost';
export const SAVE_FAILURES: Record<SaveFailure, { message: string; retry: boolean }> = {
	busy: { message: 'The register could not be saved: the local store is busy or unavailable. Nothing was changed and your entry is kept below; try again.', retry: true },
	'empty-add': { message: 'Enter a filing to add it to the register.', retry: false },
	'empty-edit': { message: 'A register row needs a filing.', retry: false },
	gone: { message: 'That register row no longer exists, so your change was not saved. Your entry is kept below: Add it again, or discard it.', retry: false },
	stale: { message: 'This row was changed elsewhere (in another tab or window) since you opened it, so your change was not saved. Your entry is kept below and the register shows the row as it is now: copy what you need, discard, then edit the row again.', retry: false },
	version: { message: 'Unknown results version: nothing was saved. Your entry is kept below.', retry: false },
	lost: { message: 'The register could not be saved: the app did not answer, so the change may or may not have been made. Your entry is kept below; check the register, then try again.', retry: true },
};
export const saveFailure = (code: unknown): SaveFailure | null => (typeof code === 'string' && Object.hasOwn(SAVE_FAILURES, code) ? (code as SaveFailure) : null);

export function rowVersion(fields: Readonly<Record<string, string>>): string {
	let h = 0x811c9dc5;
	const s = JSON.stringify(FIELDS.map((k) => fields[k] ?? ''));
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return `${s.length}:${h.toString(16)}`;
}

export function registerCsvRows(entries: readonly RegisterEntry[]): Cell[][] {
	const cell = (e: RegisterEntry, k: FilingField) => (!e.userEntered || (e.seed && e.fields[k] === e.seed[k]) ? e.fields[k] : userCell(e.fields[k]));
	return [[...FIELDS], ...entries.map((e) => FIELDS.map((k) => cell(e, k)))];
}

export function filingsCsvRows(groups: readonly FilingGroup[]): Cell[][] {
	const head = ['group', 'ref', 'date', 'title', 'note', 'doc_type', 'text_status', 'url'];
	return [head, ...groups.flatMap((g) => g.items.map((x) => [g.key, x.ref, x.date, x.title, x.note, x.doc_type, x.text_status, x.url]))];
}

export function entryNote(e: RegisterEntry): string | null {
	if (e.deletedEarlier) return 'You deleted this imported row before it changed in this results version; delete it again to confirm.';
	if (e.state === 'conflict' && e.imported) return `Your edit of an imported row that has changed since. Imported now: ${FIELDS.filter((k) => e.imported![k]).map((k) => e.imported![k]).join(' · ')}`;
	if (e.state === 'orphaned') return 'Your edit of an imported row that is not in this results version.';
	return null;
}
