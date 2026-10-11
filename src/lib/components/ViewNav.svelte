<script module lang="ts">
	// Each view's last query string (its filters and sort) per case, for this tab session only: sessionStorage, written
	// after every navigation (src/routes/v/[vid]/+layout.svelte), so the sidebar link to a view takes it back there
	// (CC-04 verification lane 01). Nothing is kept beyond the tab session, in Git or on the server. A view opened with
	// its own query keeps it: links only carry what was saved, and no address is rewritten. Whether a saved query still
	// applies is the view's concern.
	import { grouped, viewHref } from './views.ts';
	const MAX = 4096;
	const isQuery = (s: unknown): s is string => typeof s === 'string' && s.length > 1 && s.length <= MAX && /^\?[^#]*$/.test(s);
	/** The sessionStorage key of one view's last query string in one case. */
	export const queryKey = (caseId: string, viewId: string) => `clearcase:view-query:${encodeURIComponent(caseId)}:${viewId}`;
	/** The saved query string ('?…'), or '' when none is saved, the value is not a query string, or storage is blocked. */
	export function savedQuery(store: Pick<Storage, 'getItem'> | null, caseId: string, viewId: string): string {
		try { const q = store?.getItem(queryKey(caseId, viewId)); return isQuery(q) ? q : ''; } catch { return ''; }
	}
	/** Remember a view's query string; an empty one forgets it. Blocked or full storage is ignored (the link stays plain). */
	export function saveQuery(store: Pick<Storage, 'setItem' | 'removeItem'> | null, caseId: string, viewId: string, search: string) {
		try { if (isQuery(search)) store?.setItem(queryKey(caseId, viewId), search); else store?.removeItem(queryKey(caseId, viewId)); } catch { /* blocked or full */ }
	}
	/** This tab's sessionStorage, or null where reading it throws (storage blocked). */
	export const tabStorage = (): Storage | null => { try { return sessionStorage; } catch { return null; } };
	/**
	 * Save the query of the view at `address` (when it is `current`'s own path: during a navigation the two can briefly
	 * disagree), then return every view's saved query by view id.
	 */
	export function rememberQueries(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, caseId: string, resultsVersion: string, current: string | null, address: { pathname: string; search: string }) {
		const views = grouped().flatMap((g) => g.views);
		const v = views.find((x) => x.id === current);
		if (v && decodeURIComponent(address.pathname) === decodeURIComponent(viewHref(resultsVersion, v))) saveQuery(store, caseId, v.id, address.search);
		return Object.fromEntries(views.map((x) => [x.id, savedQuery(store, caseId, x.id)]));
	}
</script>

<script lang="ts">
	// The 42 navigation entries from the registry, in v5 group order. Every entry is a real link with a real history
	// entry; unavailable entries lead to an explicit "not yet available" page. Labels are the registry task names.
	import { blockedBy } from './views.ts';
	// `brand` is the case's brand (view-content `_shell.brandName`, else the case name): imported text, a text node.
	// `queries` holds each view's saved query string (rememberQueries), which its link carries.
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

<style>
	.case-brand { font-weight: 700; margin: .4rem 0 .2rem; }
</style>
