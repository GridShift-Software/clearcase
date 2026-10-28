import { error, type RequestEvent } from '@sveltejs/kit';
import { viewById, viewHref } from '$lib/components/views';
import { caseActionsFor } from '$lib/views/hosted/case-actions';
import type { HostedLayoutData } from '$lib/views/hosted/model';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { ShellShard } from '$lib/views/payloads/shell';

// The local `[vid]` layout's data from the version's shell shard, plus the shell the hosted pages render in. Only the
// case's current published version is routable here, so `isActive` is always true and there is no previous version.
export async function load(event: RequestEvent): Promise<HostedLayoutData> {
	const { locals, params } = event;
	const [v, s] = await Promise.all([publishedVersion(locals, params), shard<ShellShard>(locals, params, 'shell.json')]);
	if (s.version.id !== v.resultsVersion || s.version.caseId !== v.caseId) error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'invalid-package' });
	const rv = v.resultsVersion;
	return {
		version: s.version,
		isActive: true,
		base: v.base,
		documents: s.documents,
		shell: {
			brand: 'ClearCase',
			caseName: s.version.brand ?? s.version.caseName,
			base: v.base,
			resultsVersion: rv,
			current: null,
			published: { label: `Version ${rv.slice('sha256:'.length, 'sha256:'.length + 8)}`, at: v.publication.publishedAt, documents: s.documents },
			searchHref: viewHref(rv, viewById('search')!, v.base),
			account: null,
			actions: await caseActionsFor(v.caseId, event),
		},
	};
}
