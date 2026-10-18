import { toCSV } from '../../components/csv.ts';

export interface DefenceDoc { ref: string }
export interface DefenceRow { point: string; dcs: string; evidence: string; rebuttal: string; refs: string; docs: readonly DefenceDoc[] }

export const NEUTRAL_HEADINGS = ['Point', 'Their case', 'Supporting evidence', 'Documents', 'Rebuttal'] as const;
export const defenceHeadings = (imported: readonly string[] | null): readonly string[] => (imported && imported.length === 5 && imported.every((h) => h.trim()) ? imported : NEUTRAL_HEADINGS);

export const REFS_HEADING = 'Refs';
/** The free-text Refs column is an analysis addition (ADR 0003): shown only with the flag on, and only when a row has refs. */
export const refsShown = (rows: readonly DefenceRow[], additions: boolean) => additions && rows.some((r) => r.refs.trim());

export const NEUTRAL_CSV_KEYS = ['point', 'case', 'evidence', 'documents', 'rebuttal'] as const;
export const REFS_KEY = 'refs';
/** v5's five columns, then the refs column when the analysis additions are on (ADR 0003). */
export const defenceCsv = (keys: readonly string[], rows: readonly DefenceRow[], refs: boolean) =>
	toCSV([[...keys, ...(refs ? [REFS_KEY] : [])], ...rows.map((r) => [r.point, r.dcs, r.evidence, r.docs.map((d) => d.ref).join(' '), r.rebuttal, ...(refs ? [r.refs] : [])])]);
export const defenceCsvKeys = (cols: { keys: string[]; note: string | null }, note: string, refs: boolean): { keys: string[]; note: string | null } =>
	(refs && cols.keys.includes(REFS_KEY) ? { keys: [...NEUTRAL_CSV_KEYS], note } : cols);
export const DEFENCE_CSV_NAME = 'defence_rebuttal.csv';
