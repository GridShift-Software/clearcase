import { toCSV } from '../../components/csv.ts';

export interface RiskRow {
	issue: string;
	likelihood: string;
	impact: string;
	mitigation: string;
	likelihoodScore: number | null;
	impactScore: number | null;
	category?: string;
	owner?: string;
	refs?: readonly string[];
}

export const RISK_CSV_NAME = 'risk_matrix.csv';

export const riskColumns = (rows: readonly RiskRow[]) => ({
	category: rows.some((r) => r.category),
	owner: rows.some((r) => r.owner),
	refs: rows.some((r) => r.refs?.length),
});

export const riskScoreLabel = (level: string, score: number | null) => score === null ? level : `${level} (${score})`;

export const riskCsv = (rows: readonly RiskRow[]) => {
	const show = riskColumns(rows);
	return toCSV([
		['Issue', ...(show.category ? ['Category'] : []), 'Likelihood', 'Impact', 'Mitigation', ...(show.owner ? ['Owner'] : []), ...(show.refs ? ['Documents'] : [])],
		...rows.map((r) => [r.issue, ...(show.category ? [r.category ?? ''] : []), riskScoreLabel(r.likelihood, r.likelihoodScore), riskScoreLabel(r.impact, r.impactScore), r.mitigation, ...(show.owner ? [r.owner ?? ''] : []), ...(show.refs ? [r.refs?.join(' ') ?? ''] : [])]),
	]);
};
