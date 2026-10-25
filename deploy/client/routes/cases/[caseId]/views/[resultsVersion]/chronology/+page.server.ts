import type { RequestEvent } from '@sveltejs/kit';
import { chronologyOf, readCase, requireCurrent } from '$lib/views/hosted/case.server';
import { caseHref, notesHref } from '$lib/views/hosted/paths';

// The chronology of the case's current published version. The authorized case read comes first; a version that is not
// the current published one (superseded, withdrawn, never published or another case's) is 404. Search and filters are
// GET parameters, so the page works without client script and a filtered view has its own address.
export async function load({ locals, params, url }: RequestEvent) {
	const p = params as Record<string, string | undefined>;
	const { caseId, info } = await readCase(locals, p.caseId);
	const resultsVersion = await requireCurrent(locals, info, p.resultsVersion);
	const chronology = await chronologyOf(locals, caseId, resultsVersion, url.searchParams);
	return { caseId, label: info.caseLabel ?? info.caseId, caseHref: caseHref(caseId), notesHref: notesHref(caseId), chronology };
}
