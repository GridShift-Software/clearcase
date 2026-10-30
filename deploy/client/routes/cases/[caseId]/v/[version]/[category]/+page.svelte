<script lang="ts">
	import UnavailableView from '$lib/components/UnavailableView.svelte';
	import type { ViewEntry } from '$lib/components/view-registry';
	import type { HostedLayoutData } from '$lib/views/hosted/model';
	let { data }: { data: HostedLayoutData & { view: ViewEntry; status: 'soon' } } = $props();
</script>

<main id="main" tabindex="-1" data-ready={data.view.id}>
	<UnavailableView view={data.view} caseName={data.version.titleName} status={data.status} resultsVersion={data.version.id} />
</main>
