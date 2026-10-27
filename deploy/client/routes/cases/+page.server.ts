import type { RequestEvent } from '@sveltejs/kit';
import { refuse } from '$lib/server/runtime/hosted/http';

export async function load({ locals, url }: RequestEvent) {
	const cases = await locals.store.listCases().catch((e) => refuse(e));
	return {
		multipleSignIns: url.searchParams.get('signIn') === 'multiple-tabs',
		subject: locals.identity.principal?.subject ?? null,
		cases: cases.map((c) => ({ caseId: c.caseId, label: c.caseLabel ?? c.caseId, href: c.href, published: c.publication.kind === 'published' })),
	};
}
