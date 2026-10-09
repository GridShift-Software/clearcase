// Defence & Rebuttal (GRS-15): the CSV export and the column headings. Browser-safe.
import { toCSV } from '../../components/csv.ts';

export interface DefenceDoc { ref: string }
export interface DefenceRow { point: string; dcs: string; evidence: string; rebuttal: string; refs: string; docs: readonly DefenceDoc[] }

/**
 * The five column headings. v5 hard-codes them with the parties' abbreviations (S-vdm_matrix_tab-2), so they come from
 * the package's view-content list; without exactly five, neutral headings stand in.
 */
export const NEUTRAL_HEADINGS = ['Point', 'Their case', 'Supporting evidence', 'Documents', 'Rebuttal'] as const;
export const defenceHeadings = (imported: readonly string[] | null): readonly string[] => (imported && imported.length === 5 && imported.every((h) => h.trim()) ? imported : NEUTRAL_HEADINGS);

/** The heading of the free-text refs column, which v5 never shows (S-vdm_matrix_tab-1). */
export const REFS_HEADING = 'Refs';

/**
 * v5's export (exportDefence: point, case, evidence, documents as refs joined by one space, rebuttal), with the
 * free-text refs v5 never exported appended as a last column (S-vdm_matrix_tab-1), so v5's column order is kept.
 * Imported values are exported unchanged.
 */
export const DEFENCE_CSV_COLUMNS = ['dcs_point', 'dcs_case', 'ess_evidence', 'documents', 'rebuttal', 'refs'] as const;
export const defenceCsv = (rows: readonly DefenceRow[]) =>
	toCSV([[...DEFENCE_CSV_COLUMNS], ...rows.map((r) => [r.point, r.dcs, r.evidence, r.docs.map((d) => d.ref).join(' '), r.rebuttal, r.refs])]);
export const DEFENCE_CSV_NAME = 'defence_rebuttal.csv';
