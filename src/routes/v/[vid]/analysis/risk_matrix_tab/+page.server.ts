import { analysisDataset, existingOf } from '$lib/analysis/data.server';
import type { PageServerLoad } from './$types';

interface Risk { issue: string; likelihood: string; impact: string; mitigation: string; likelihood_score?: unknown; impact_score?: unknown; category?: string; owner?: string; refs?: string[] }
const score = (v: unknown) => (typeof v === 'number' ? v : null);

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	// category, owner and refs come only from a generation that carries them (the newer builder, the JSON script's type and owner); v5 has none
	const risks = (analysisDataset<Risk[]>(version.id, 'risk-matrix') ?? []).map((r) => ({
		issue: r.issue, likelihood: r.likelihood, impact: r.impact, mitigation: r.mitigation, likelihoodScore: score(r.likelihood_score), impactScore: score(r.impact_score),
		...(r.category !== undefined && { category: r.category }), ...(r.owner !== undefined && { owner: r.owner }), ...(r.refs !== undefined && { refs: r.refs }),
	}));
	const refs = risks.flatMap((r) => r.refs ?? []);
	return { risks, ...(refs.length > 0 && { known: existingOf(version.id, refs) }) };
};
