import type { RequestEvent } from '@sveltejs/kit';
import type { NoteSummary } from '$lib/server/runtime/contracts';
import { refuse } from '$lib/server/runtime/hosted/http';
import { overviewMerge } from '$lib/views/overview/merge';
import { hostedOverviewSlots, hostedRegisterSlots } from '$lib/views/hosted/overview-slots.server';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { OverviewShard } from '$lib/views/payloads/overview';

// The overview shard, merged with the user's notes summary and the hosted slots. There is no previous version and no
// rollback on hosted.
export async function load({ locals, params }: RequestEvent) {
	const v = await publishedVersion(locals, params);
	const [data, summary, registerSlots] = await Promise.all([
		shard<OverviewShard>(locals, params, 'overview.json'),
		locals.userWork.summary({ caseId: v.caseId, resultsVersion: v.resultsVersion }).catch((e: unknown) => refuse(e)),
		hostedRegisterSlots(locals, { caseId: v.caseId }),
	]);
	// The overview lists notes by ref; a detached note's own text is the notes page's, not the overview's.
	const notes: NoteSummary = { ...summary, detached: [] };
	const built = data.tallies.claims.find(([k]) => k === 'builtAt')?.[1];
	const slots = [...registerSlots, ...hostedOverviewSlots({ resultsVersion: v.resultsVersion, base: v.base, builtAt: typeof built === 'string' && built ? built : data.overview.created, documents: data.documents.total })];
	return overviewMerge(data, { notes, previous: null, slots });
}
