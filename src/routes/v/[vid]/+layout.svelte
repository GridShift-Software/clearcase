<script lang="ts">
	import { page } from '$app/state';
	import ViewNav from '$lib/components/ViewNav.svelte';
	let { data, children } = $props();
	const v = $derived(data.version);
	// the view id of the current route (overview, chronology, or /<category>/<view>); document detail has none
	const current = $derived(page.route.id?.endsWith('/[category]/[view]') ? page.params.view ?? null : page.route.id?.split('/').at(-1) ?? null);
</script>

{#if data.isActive}
	<div class="banner active" id="active-banner">{v.caseName}: active results version</div>
{:else}
	<div class="banner candidate" id="candidate-banner" role="status">CANDIDATE PREVIEW of {v.caseName}: this results version is not active. <a href="/import/{v.importId}">Back to its validation report</a></div>
{/if}
<div class="case-shell">
	<ViewNav resultsVersion={v.id} {current} brand={v.brand} />
	{@render children()}
</div>
