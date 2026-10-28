<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell from '$lib/components/AppShell.svelte';
	import ViewNav, { rememberQueries, tabStorage } from '$lib/components/ViewNav.svelte';
	import type { ShellData } from '$lib/components/shell';
	import { viewById, viewHref } from '$lib/components/views';
	let { data, children } = $props();
	const v = $derived(data.version);
	const current = $derived(page.route.id?.endsWith('/[category]/[view]') ? page.params.view ?? null : page.route.id?.split('/').at(-1) ?? null);
	const shell = $derived<ShellData>({
		brand: 'ClearCase',
		caseName: v.brand ?? v.caseName,
		base: data.base,
		resultsVersion: v.id,
		current,
		published: { label: data.isActive ? 'Active results version' : 'Candidate preview', at: null, documents: data.documents },
		searchHref: viewHref(v.id, viewById('search')!, data.base),
		account: null,
		actions: [{ label: '← All cases', href: '/cases' }],
	});
	let queries = $state<Record<string, string>>({});
	const remember = () => { queries = rememberQueries(tabStorage(), v.caseId, v.id, current, location, data.base); };
	afterNavigate(remember);
	$effect(() => { void page.state; remember(); });
</script>

<AppShell {shell}>
	{#snippet notice()}
		{#if data.isActive}
			<div class="banner active" id="active-banner">{v.caseName}: active results version</div>
		{:else}
			<div class="banner candidate" id="candidate-banner" role="status">CANDIDATE PREVIEW of {v.caseName}: this results version is not active. <a href="/import/{v.importId}">Back to its validation report</a></div>
		{/if}
		<p class="note">Results produced <b>{v.created.slice(0, 10)}</b> · Prepared by ClearCase from the documents in the case folder; check anything you rely on against the source document.</p>
	{/snippet}
	{#snippet sidebar()}<ViewNav resultsVersion={v.id} {current} brand={v.brand} {queries} />{/snippet}
	{@render children()}
</AppShell>
