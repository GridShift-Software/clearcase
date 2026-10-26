import type { RequestEvent } from '@sveltejs/kit';
import type { ResultsStatus } from '$lib/server/runtime/contracts';
import { currentVersion, overviewOf, part, readCase, type OverviewData } from '$lib/views/hosted/case.server';
import { notesHref, originalHref } from '$lib/views/hosted/paths';

// The case shell works from the stable case identity alone: the authorized case read comes first, then originals and
// the user's own work load whether or not a results version is published, and neither waits on one. Results show only
// for the current published version (src/lib/views/hosted/case.server.ts). A fault in one part shows as that part
// unavailable; a refusal of authority fails the whole page.
export async function load({ locals, params }: RequestEvent) {
	const { caseId, info } = await readCase(locals, (params as Record<string, string | undefined>).caseId);
	const label = info.caseLabel ?? info.caseId;
	const resultsPart = async (): Promise<{ results: ResultsStatus | null; overview: OverviewData | null }> => {
		const current = await currentVersion(locals, info);
		if (current.kind === 'status') return { results: current.status, overview: null };
		const o = await part(overviewOf(locals, caseId, current.resultsVersion, label));
		if (o.state === 'available' && o.value) return { results: null, overview: o.value };
		return { results: { kind: 'unavailable', reason: 'The published results cannot be shown right now. Try again shortly.' }, overview: null };
	};
	const [results, originals, notes] = await Promise.all([resultsPart(), part(locals.assets.originals({ caseId })), part(locals.userWork.notesFor({ caseId, target: null }))]);
	return {
		caseId: info.caseId,
		label,
		results: results.results,
		overview: results.overview,
		originals: originals.state === 'available' ? { state: 'available' as const, items: originals.value.map((o) => ({ assetId: o.assetId, filename: o.filename, mediaType: o.mediaType, size: o.size, href: originalHref(caseId, o.assetId) })) } : { state: 'unavailable' as const, items: [] },
		notes: notes.state === 'available' ? { state: 'available' as const, count: notes.value.length, href: notesHref(caseId) } : { state: 'unavailable' as const, count: 0, href: notesHref(caseId) },
	};
}
