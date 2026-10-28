<script module lang="ts">
	import { grouped, viewHref as hrefOf, type ViewEntry } from './views.ts';
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
	export function rememberQueries(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, caseId: string, resultsVersion: string, current: string | null, address: { pathname: string; search: string }, base?: string) {
		const views = grouped().flatMap((g) => g.views);
		const v = views.find((x) => x.id === current);
		if (v && decodeURIComponent(address.pathname) === decodeURIComponent(hrefOf(resultsVersion, v, base))) saveQuery(store, caseId, v.id, address.search);
		return Object.fromEntries(views.map((x) => [x.id, savedQuery(store, caseId, x.id)]));
	}
</script>

<script lang="ts">
	import { hostedStatus } from '../views/hosted/availability.ts';
	import { routeBase } from './shell.ts';
	import { blockedBy } from './views.ts';
	let { resultsVersion, current = null, brand = null, queries = {}, hosted = false }: { resultsVersion: string; current?: string | null; brand?: string | null; queries?: Record<string, string>; hosted?: boolean } = $props();
	const base = routeBase();
	const viewHref = (rv: string, v: ViewEntry) => hrefOf(rv, v, base());
	const groups = $derived(grouped().map((g) => ({ ...g, views: hosted ? g.views.filter((v) => hostedStatus(v.id) !== 'never') : g.views })).filter((g) => g.views.length));
</script>

<nav class="views" aria-label="Case views">
	{#if brand}<p class="case-brand wrap" id="case-brand">{brand}</p>{/if}
	{#each groups as g (g.group)}
		<section aria-labelledby="nav-group-{g.group.replace(/\W+/g, '-')}">
			<h2 id="nav-group-{g.group.replace(/\W+/g, '-')}">{g.group}</h2>
			<ul>
				{#each g.views as v (v.id)}
					{@const owner = blockedBy(v)}
					{@const status = hosted ? hostedStatus(v.id) : undefined}
					<li>
						<a href="{viewHref(resultsVersion, v)}{queries[v.id] ?? ''}" id="nav-{v.id}" data-view={v.id} data-status={v.status} data-hosted-status={status} aria-disabled={status === 'soon' ? 'true' : undefined} aria-current={current === v.id ? 'page' : undefined} class:unavailable={!!owner || status === 'soon'}>
							{v.label}{#if owner}<span class="visually-hidden"> (not yet available)</span>{:else if status === 'soon'}<span class="visually-hidden"> (coming soon)</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</nav>
