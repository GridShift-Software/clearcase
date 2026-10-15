import { analysisDataset } from '$lib/analysis/data.server';
import type { PageServerLoad } from './$types';

interface Risk { issue: string; likelihood: string; impact: string; mitigation: string; likelihood_score?: unknown; impact_score?: unknown }
const score = (v: unknown) => (typeof v === 'number' ? v : null);

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return { risks: (analysisDataset<Risk[]>(version.id, 'risk-matrix') ?? []).map((r) => ({ issue: r.issue, likelihood: r.likelihood, impact: r.impact, mitigation: r.mitigation, likelihoodScore: score(r.likelihood_score), impactScore: score(r.impact_score) })) };
};
