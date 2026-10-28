import { toCSV, userCell } from '../../components/csv.ts';
import type { VersionedRow } from '../../local-case/registers.server.ts';
import type { authoritiesPure } from './register.server.ts';

export const AUTH_FIELDS = ['topic', 'authority', 'proposition'] as const;
export type AuthValues = Record<(typeof AUTH_FIELDS)[number], string>;

export const canAddAuthority = (v: AuthValues) => !!v.authority;

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const authoritiesCsv = (imported: readonly Readonly<Record<string, unknown>>[], user: readonly AuthValues[]) =>
	toCSV([[...AUTH_FIELDS], ...imported.map((r) => AUTH_FIELDS.map((k) => cell(r[k]))), ...user.map((r) => AUTH_FIELDS.map((k) => userCell(r[k])))]);

export const AUTH_FILE = 'authorities.csv';

/** The Authorities shard (ticket 04): the view without the user's rows. */
export type AuthoritiesShard = ReturnType<typeof authoritiesPure>;

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The Authorities page data from its shard, the user's rows in register order and the add form's id. */
export function authoritiesMerge(shard: AuthoritiesShard, work: { rows: readonly VersionedRow[] }, addId: string) {
	const user = work.rows.map((r) => ({ rowId: r.rowId, ...(Object.fromEntries(AUTH_FIELDS.map((k) => [k, text(r.fields[k])])) as AuthValues) }));
	return { present: shard.present, imported: shard.imported, user, known: shard.known, addId, exportName: shard.exportName };
}
