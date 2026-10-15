<script lang="ts">
	import PageHeader from './PageHeader.svelte';
	import type { ViewEntry } from './view-registry.ts';
	import { blockedBy } from './views.ts';
	let { view, caseName }: { view: ViewEntry; caseName: string } = $props();
</script>

<PageHeader heading={view.label} section={view.label} {caseName} status="not yet available" />
<section class="unavailable-view" data-unavailable={view.id} data-owner={blockedBy(view)}>
	<p><strong>{view.label} is not yet available</strong> — owned by {blockedBy(view)} ({view.owner}).</p>
	<p>This view arrives with that issue. Nothing on this page is a result: no data from this case is shown here, and nothing is computed.</p>
</section>
