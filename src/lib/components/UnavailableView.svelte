<script lang="ts">
	import PageHeader from './PageHeader.svelte';
	import { routeBase } from './shell.ts';
	import type { ViewEntry } from './view-registry.ts';
	import { blockedBy, viewById, viewHref } from './views.ts';
	import type { HostedStatus } from '../views/hosted/availability.ts';
	type Props = { view: ViewEntry; caseName: string } & ({ status?: undefined; resultsVersion?: string } | { status: Exclude<HostedStatus, 'ported'>; resultsVersion: string });
	let { view, caseName, status, resultsVersion }: Props = $props();
	const base = routeBase();
</script>

{#snippet icon()}
	<span class="uv-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="24" cy="24" r="18" /><path d="M24 14v10l7 4" /></svg></span>
{/snippet}

{#if status}
	<PageHeader heading={view.label} section={view.label} {caseName} status={status === 'soon' ? 'coming soon' : 'not available'} />
	<section class="unavailable-view" data-unavailable={view.id} data-hosted-status={status}>
		{@render icon()}
		<h2 class="uv-title">{status === 'soon' ? 'Coming soon' : 'Not available here'}</h2>
		<p>{status === 'soon' ? `${view.label} is not part of this release yet.` : `${view.label} is not offered in this version of ClearCase.`}</p>
		<p class="uv-back"><a class="btn" href={viewHref(resultsVersion!, viewById('overview')!, base())}>Back to Overview</a></p>
	</section>
{:else}
	<PageHeader heading={view.label} section={view.label} {caseName} status="not yet available" />
	<section class="unavailable-view" data-unavailable={view.id} data-owner={blockedBy(view)}>
		{@render icon()}
		<p class="uv-title"><strong>{view.label} is not yet available</strong> — owned by {blockedBy(view)} ({view.owner}).</p>
		<p>This view arrives with that issue. Nothing on this page is a result: no data from this case is shown here, and nothing is computed.</p>
	</section>
{/if}
