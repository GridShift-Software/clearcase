import { toCSV, userCell } from '../../components/csv.ts';

export const AUTH_FIELDS = ['topic', 'authority', 'proposition'] as const;
export type AuthValues = Record<(typeof AUTH_FIELDS)[number], string>;

export const canAddAuthority = (v: AuthValues) => !!v.authority;

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const authoritiesCsv = (imported: readonly Readonly<Record<string, unknown>>[], user: readonly AuthValues[]) =>
	toCSV([[...AUTH_FIELDS], ...imported.map((r) => AUTH_FIELDS.map((k) => cell(r[k]))), ...user.map((r) => AUTH_FIELDS.map((k) => userCell(r[k])))]);

export const AUTH_FILE = 'authorities.csv';
