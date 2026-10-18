import { toCSV } from '../../components/csv.ts';

export interface DefenceDoc { ref: string }
export interface DefenceRow { point: string; dcs: string; evidence: string; rebuttal: string; refs: string; docs: readonly DefenceDoc[] }

export const NEUTRAL_HEADINGS = ['Point', 'Their case', 'Supporting evidence', 'Documents', 'Rebuttal'] as const;
export const defenceHeadings = (imported: readonly string[] | null): readonly string[] => (imported && imported.length === 5 && imported.every((h) => h.trim()) ? imported : NEUTRAL_HEADINGS);

export const REFS_HEADING = 'Refs';

export const NEUTRAL_CSV_KEYS = ['point', 'case', 'evidence', 'documents', 'rebuttal'] as const;
export const REFS_KEY = 'refs';
export const defenceCsv = (keys: readonly string[], rows: readonly DefenceRow[]) =>
	toCSV([[...keys, REFS_KEY], ...rows.map((r) => [r.point, r.dcs, r.evidence, r.docs.map((d) => d.ref).join(' '), r.rebuttal, r.refs])]);
export const defenceCsvKeys = (cols: { keys: string[]; note: string | null }, note: string): { keys: string[]; note: string | null } =>
	(cols.keys.includes(REFS_KEY) ? { keys: [...NEUTRAL_CSV_KEYS], note } : cols);
export const DEFENCE_CSV_NAME = 'defence_rebuttal.csv';
