import { error } from '@sveltejs/kit';
import type { ChronologyListRow } from '$lib/local-case/model';
import type { PageLoad } from './$types';

// The per-version list is revalidated JSON (private, no-cache + read-model ETag): warm navigation costs a 304.
export const load: PageLoad = async ({ fetch, params }) => {
	const r = await fetch(`/api/v/${encodeURIComponent(params.vid)}/chronology`);
	if (!r.ok) error(r.status, (await r.text()).slice(0, 300) || 'chronology unavailable');
	const degraded = r.headers.get('x-clearcase-degraded');
	return { rows: (await r.json()) as ChronologyListRow[], failed: degraded ? (JSON.parse(decodeURIComponent(degraded)) as { source: string; owner: string; reason: string }[]) : [] };
};
