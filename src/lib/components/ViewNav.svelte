<script module lang="ts">
	import { grouped, viewHref } from './views.ts';
	const MAX = 4096;
	const isQuery = (s: unknown): s is string => typeof s === 'string' && s.length > 1 && s.length <= MAX && /^\?[^#]*$/.test(s);
	export const queryKey = (caseId: string, viewId: string) => `clearcase:view-query:${encodeURIComponent(caseId)}:${viewId}`;
	export function savedQuery(store: Pick<Storage, 'getItem'> | null, caseId: string, viewId: string): string {
		try { const q = store?.getItem(queryKey(caseId, viewId)); return isQuery(q) ? q : ''; } catch { return ''; }
	}
	export function saveQuery(store: Pick<Storage, 'setItem' | 'removeItem'> | null, caseId: string, viewId: string, search: string) {
		try { if (isQuery(search)) store?.setItem(queryKey(caseId, viewId), search); else store?.removeItem(queryKey(caseId, viewId)); } catch { /* blocked or full */ }
	}
	export const tabStorage = (): Storage | null => { try { return sessionStorage; } catch { return null; } };
	export function rememberQueries(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, caseId: string, resultsVersion: string, current: string | null, address: { pathname: string; search: string }) {
		const views = grouped().flatMap((g) => g.views);
		const v = views.find((x) => x.id === current);
		if (v && decodeURIComponent(address.pathname) === decodeURIComponent(viewHref(resultsVersion, v))) saveQuery(store, caseId, v.id, address.search);
		return Object.fromEntries(views.map((x) => [x.id, savedQuery(store, caseId, x.id)]));
	}
</script>

<script lang="ts">
	import { blockedBy } from './views.ts';
	let { resultsVersion, current = null, brand = null, queries = {} }: { resultsVersion: string; current?: string | null; brand?: string | null; queries?: Record<string, string> } = $props();
	const groups = grouped();
</script>

<nav class="views" aria-label="Case views">
	{#if brand}<p class="case-brand wrap" id="case-brand">{brand}</p>{/if}
	{#each groups as g (g.group)}
		<section aria-labelledby="nav-group-{g.group.replace(/\W+/g, '-')}">
			<h2 id="nav-group-{g.group.replace(/\W+/g, '-')}">{g.group}</h2>
			<ul>
				{#each g.views as v (v.id)}
					{@const owner = blockedBy(v)}
					<li>
						<a href="{viewHref(resultsVersion, v)}{queries[v.id] ?? ''}" id="nav-{v.id}" data-view={v.id} data-status={v.status} aria-current={current === v.id ? 'page' : undefined} class:unavailable={!!owner}>
							{v.label}{#if owner}<span class="visually-hidden"> (not yet available)</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</nav>
