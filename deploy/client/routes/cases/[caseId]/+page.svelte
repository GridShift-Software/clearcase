<script lang="ts">
	import ResultsState from '$lib/components/ResultsState.svelte';
	import CaseOverview from '$lib/views/hosted/CaseOverview.svelte';
	import { displayFilename } from '$lib/views/hosted/display';
	import type { ResultsStatus } from '$lib/server/runtime/contracts';
	import type { OverviewData } from '$lib/views/hosted/model';
	type Original = { assetId: string; filename: string; mediaType: string; size: number; href: string };
	let { data }: { data: { caseId: string; label: string; results: ResultsStatus | null; overview: OverviewData | null; originals: { state: 'available' | 'unavailable'; items: Original[] }; notes: { state: 'available' | 'unavailable'; count: number; href: string } } } = $props();
</script>

<h1 data-case-id={data.caseId}>{displayFilename(data.label)}</h1>
{#if data.results}<ResultsState status={data.results} />{/if}
{#if data.overview}<CaseOverview overview={data.overview} />{/if}

<section aria-labelledby="originals-title" data-originals-state={data.originals.state}>
	<h2 id="originals-title">Originals</h2>
	{#if data.originals.state === 'unavailable'}
		<p>Originals are unavailable right now. Try again shortly.</p>
	{:else if data.originals.items.length}
		<ul>
			{#each data.originals.items as o (o.assetId)}
				<li>
					<a data-action="open-original" data-asset-id={o.assetId} href={o.href}>{displayFilename(o.filename)}</a>
					({o.mediaType}, {o.size} bytes)
					{#if o.mediaType === 'application/pdf'} <a data-action="view-original" data-asset-id={o.assetId} href={`${o.href}/view`}>View PDF</a>{/if}
				</li>
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
		<p>{data.notes.count} notes on this case. <a data-action="open-notes" href={data.notes.href}>Open your notes</a></p>
	{/if}
</section>
