<script lang="ts">
	import Page from '$local/overview/+page.svelte';
	import type { ComponentProps } from 'svelte';
	let { data }: { data: ComponentProps<typeof Page>['data'] } = $props();
</script>

<Page {data} form={null} />
