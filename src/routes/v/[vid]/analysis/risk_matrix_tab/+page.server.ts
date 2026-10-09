import { analysisDataset } from '$lib/analysis/data.server';
import type { PageServerLoad } from './$types';

interface Risk { issue: string; likelihood: string; impact: string; mitigation: string }

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return { risks: (analysisDataset<Risk[]>(version.id, 'risk-matrix') ?? []).map((r) => ({ issue: r.issue, likelihood: r.likelihood, impact: r.impact, mitigation: r.mitigation })) };
};
