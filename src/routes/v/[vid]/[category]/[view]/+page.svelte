<script lang="ts">
	import UnavailableView from '$lib/components/UnavailableView.svelte';
	let { data } = $props();
</script>

<main id="main" tabindex="-1" data-ready="view:{data.view.id}">
	<UnavailableView view={data.view} caseName={data.version.titleName} />
</main>
