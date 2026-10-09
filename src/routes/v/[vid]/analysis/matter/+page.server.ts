import { analysisDataset, citedExisting } from '$lib/analysis/data.server';
import type { PageServerLoad } from './$types';

interface Heading { h: string; t: string }
interface Matter { title: string; storyline: Heading[]; strategy: Heading[] }

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const m = analysisDataset<Matter>(version.id, 'matter');
	const matter = m ? { title: m.title, storyline: m.storyline, strategy: m.strategy } : null;
	return { matter, known: matter ? citedExisting(version.id, [...matter.storyline, ...matter.strategy].map((s) => s.t)) : [] };
};
