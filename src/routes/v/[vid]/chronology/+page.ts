import { error } from '@sveltejs/kit';
import type { ChronologyListRow } from '$lib/local-case/model';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, fetch }) => {
	const r = await fetch(data.listHref);
	if (!r.ok) error(r.status, (await r.text()).slice(0, 300) || 'chronology unavailable');
	const degraded = r.headers.get('x-clearcase-degraded');
	return { ...data, rows: (await r.json()) as ChronologyListRow[], failed: degraded ? (JSON.parse(decodeURIComponent(degraded)) as { source: string; owner: string; reason: string }[]) : [] };
};
