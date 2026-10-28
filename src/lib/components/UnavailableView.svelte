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

{#if status}
	<PageHeader heading={view.label} section={view.label} {caseName} status={status === 'soon' ? 'coming soon' : 'not available'} />
	<section class="unavailable-view" data-unavailable={view.id} data-hosted-status={status}>
		<p><strong>{status === 'soon' ? 'Coming soon' : 'Not available here'}</strong></p>
		<p><a href={viewHref(resultsVersion!, viewById('overview')!, base())}>Back to Overview</a></p>
	</section>
{:else}
	<PageHeader heading={view.label} section={view.label} {caseName} status="not yet available" />
	<section class="unavailable-view" data-unavailable={view.id} data-owner={blockedBy(view)}>
		<p><strong>{view.label} is not yet available</strong> — owned by {blockedBy(view)} ({view.owner}).</p>
		<p>This view arrives with that issue. Nothing on this page is a result: no data from this case is shown here, and nothing is computed.</p>
	</section>
{/if}
