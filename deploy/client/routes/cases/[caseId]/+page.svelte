<script lang="ts">
	import ResultsState from '$lib/components/ResultsState.svelte';
	import type { ResultsStatus } from '$lib/server/runtime/contracts';
	type Original = { assetId: string; filename: string; mediaType: string; size: number; href: string };
	let { data }: { data: { caseId: string; label: string; results: ResultsStatus | null; originals: { state: 'available' | 'unavailable'; items: Original[] }; notes: { state: 'available' | 'unavailable'; count: number } } } = $props();
</script>

<h1 data-case-id={data.caseId}>{data.label}</h1>
{#if data.results}<ResultsState status={data.results} />{/if}

<section aria-labelledby="originals-title" data-originals-state={data.originals.state}>
	<h2 id="originals-title">Originals</h2>
	{#if data.originals.state === 'unavailable'}
		<p>Originals are unavailable right now. Try again shortly.</p>
	{:else if data.originals.items.length}
		<ul>
			{#each data.originals.items as o (o.assetId)}
				<li><a data-action="open-original" data-asset-id={o.assetId} href={o.href}>{o.filename}</a> ({o.mediaType}, {o.size} bytes)</li>
			{/each}
		</ul>
	{:else}
		<p>No originals are recorded for this case.</p>
	{/if}
</section>

<section aria-labelledby="notes-title" data-user-work-state={data.notes.state}>
	<h2 id="notes-title">Your notes</h2>
	{#if data.notes.state === 'unavailable'}
		<p>Your notes are unavailable on this deployment until user-work storage is connected. They never depend on published results.</p>
	{:else}
		<p>{data.notes.count} notes on this case.</p>
	{/if}
</section>
