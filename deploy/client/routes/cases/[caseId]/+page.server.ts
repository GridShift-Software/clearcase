import { error, type RequestEvent } from '@sveltejs/kit';
import type { ResultsStatus } from '$lib/server/runtime/contracts';
import { refuse } from '$lib/server/runtime/hosted/http';
import { codeOf, isDenial } from '$lib/server/runtime/errors';
import { id } from '$lib/server/runtime/ids';

const CASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The case shell works from the stable case identity alone: originals and the user's own work load whether or not a
// results version is published, and neither waits on one. A fault in one part shows as that part unavailable; a
// refusal of authority fails the whole page.
export async function load({ locals, params }: RequestEvent) {
	const raw = (params as Record<string, string | undefined>).caseId;
	if (!raw || !CASE.test(raw)) error(404, { message: 'Not found.', code: 'not-found' });
	const caseId = id('case', raw);
	const info = await locals.store.getCase({ caseId }).catch((e) => refuse(e));
	if (!info) error(404, { message: 'Not found.', code: 'not-found' });
	const part = <T>(work: Promise<T>) => work.then((value) => ({ ok: true as const, value }), (e: unknown) => (isDenial(e) ? refuse(e) : { ok: false as const, code: codeOf(e) ?? 'error' }));
	const [originals, notes] = await Promise.all([part(locals.assets.originals({ caseId })), part(locals.userWork.notesFor({ caseId, target: { kind: 'case' } }))]);
	const results: ResultsStatus | null =
		info.publication.kind === 'none' ? { kind: 'pending' } : info.publication.kind === 'withdrawn' ? { kind: 'withdrawn' } : { kind: 'unavailable', reason: 'The published results cannot be shown: results storage is not connected to this deployment yet.' };
	return {
		caseId: info.caseId,
		label: info.caseLabel ?? info.caseId,
		results,
		originals: originals.ok ? { state: 'available' as const, items: originals.value.map((o) => ({ ...o, href: `/cases/${encodeURIComponent(caseId)}/originals/${encodeURIComponent(o.assetId)}` })) } : { state: 'unavailable' as const, items: [] },
		notes: notes.ok ? { state: 'available' as const, count: notes.value.length } : { state: 'unavailable' as const, count: 0 },
	};
}
