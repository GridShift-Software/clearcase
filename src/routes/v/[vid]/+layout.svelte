<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import ViewNav, { rememberQueries, tabStorage } from '$lib/components/ViewNav.svelte';
	let { data, children } = $props();
	const v = $derived(data.version);
	// the view id of the current route (overview, chronology, or /<category>/<view>); document detail has none
	const current = $derived(page.route.id?.endsWith('/[category]/[view]') ? page.params.view ?? null : page.route.id?.split('/').at(-1) ?? null);
	// Each view's last query in this case, for this tab session (ViewNav.svelte): saved after every navigation, and after
	// a view updates its own query without one (a shallow replaceState, as the chronology filters do, changes
	// page.state), so the sidebar link takes it back. Empty until the page runs in the browser: links render as served.
	let queries = $state<Record<string, string>>({});
	const remember = () => { queries = rememberQueries(tabStorage(), v.caseId, v.id, current, location); };
	afterNavigate(remember);
	$effect(() => { void page.state; remember(); });
</script>

{#if data.isActive}
	<div class="banner active" id="active-banner">{v.caseName}: active results version</div>
{:else}
	<div class="banner candidate" id="candidate-banner" role="status">CANDIDATE PREVIEW of {v.caseName}: this results version is not active. <a href="/import/{v.importId}">Back to its validation report</a></div>
{/if}
<div class="case-shell">
	<ViewNav resultsVersion={v.id} {current} brand={v.brand} {queries} />
	{@render children()}
</div>
