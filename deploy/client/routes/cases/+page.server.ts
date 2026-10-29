import type { RequestEvent } from '@sveltejs/kit';
import { displayName } from '$lib/auth/display-name';
import { refuse } from '$lib/server/runtime/hosted/http';

export async function load({ locals, url }: RequestEvent) {
	const cases = await locals.store.listCases().catch((e) => refuse(e));
	return {
		multipleSignIns: url.searchParams.get('signIn') === 'multiple-tabs',
		name: displayName(locals.identity),
		cases: cases.map((c) => ({ caseId: c.caseId, label: c.caseLabel ?? c.caseId, href: c.href, published: c.publication.kind === 'published' })),
	};
}
