<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import ViewNav, { rememberQueries, tabStorage } from '$lib/components/ViewNav.svelte';
	let { data, children } = $props();
	const v = $derived(data.version);
	const current = $derived(page.route.id?.endsWith('/[category]/[view]') ? page.params.view ?? null : page.route.id?.split('/').at(-1) ?? null);
	let queries = $state<Record<string, string>>({});
	const remember = () => { queries = rememberQueries(tabStorage(), v.caseId, v.id, current, location); };
	afterNavigate(remember);
	$effect(() => { void page.state; remember(); });
</script>

<div class="case-head">
	<a class="back" href="/cases" id="back-to-cases">← All cases</a>
	<div class="case-title">
		<p class="case-name" id="case-name">{v.brand ?? v.caseName}</p>
		{#if data.isActive}
			<div class="banner active" id="active-banner">{v.caseName}: active results version</div>
		{:else}
			<div class="banner candidate" id="candidate-banner" role="status">CANDIDATE PREVIEW of {v.caseName}: this results version is not active. <a href="/import/{v.importId}">Back to its validation report</a></div>
		{/if}
	</div>
	<p class="note">Results produced <b>{v.created.slice(0, 10)}</b> · Prepared by ClearCase from the documents in the case folder; check anything you rely on against the source document.</p>
</div>
<div class="case-shell">
	<ViewNav resultsVersion={v.id} {current} brand={v.brand} {queries} />
	{@render children()}
</div>
