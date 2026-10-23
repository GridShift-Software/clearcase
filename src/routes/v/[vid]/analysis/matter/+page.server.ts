import { analysisDataset, citedExisting, existingOf } from '$lib/analysis/data.server';
import type { Anchor, RelationshipGraph } from '$lib/views/analysis/supplemental';
import type { PageServerLoad } from './$types';

interface Heading { h: string; t: string }
interface Matter { title: string; storyline: Heading[]; strategy: Heading[] }

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const m = analysisDataset<Matter>(version.id, 'matter');
	const matter = m ? { title: m.title, storyline: m.storyline, strategy: m.strategy } : null;
	const anchors = analysisDataset<Anchor[]>(version.id, 'anchors');
	const graph = analysisDataset<RelationshipGraph>(version.id, 'organogram');
	const refs = [...(anchors ?? []).map((a) => a.ref), ...(graph?.nodes ?? []).flatMap((n) => n.refs ?? []), ...(graph?.edges ?? []).flatMap((e) => e.refs ?? [])];
	return { matter, anchors, graph, known: [...new Set([...(matter ? citedExisting(version.id, [...matter.storyline, ...matter.strategy].map((s) => s.t)) : []), ...existingOf(version.id, refs)])] };
};
