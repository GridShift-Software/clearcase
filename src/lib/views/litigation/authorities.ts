// Authorities (authorities_tab): the package's authorities (`lit-authorities`, not a seed dataset) followed by the
// user's own (register store `authorities`, by `seq`), and their CSV export. Browser-safe.
import { toCSV, userCell } from '../../components/csv.ts';

export const AUTH_FIELDS = ['topic', 'authority', 'proposition'] as const;
export type AuthValues = Record<(typeof AUTH_FIELDS)[number], string>;

/** v5 addAuth: an entry needs an authority; otherwise nothing is added. */
export const canAddAuthority = (v: AuthValues) => !!v.authority;

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** v5 exportAuth: header, the imported rows unchanged, then the user's rows with each cell neutralised (userCell). */
export const authoritiesCsv = (imported: readonly Readonly<Record<string, unknown>>[], user: readonly AuthValues[]) =>
	toCSV([[...AUTH_FIELDS], ...imported.map((r) => AUTH_FIELDS.map((k) => cell(r[k]))), ...user.map((r) => AUTH_FIELDS.map((k) => userCell(r[k])))]);

/** The export's file name: generic (v5's name carried the case's abbreviations; S-hardcoded-case). */
export const AUTH_FILE = 'authorities.csv';
