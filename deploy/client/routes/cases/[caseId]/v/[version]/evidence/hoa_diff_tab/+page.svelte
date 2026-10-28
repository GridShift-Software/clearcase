<script lang="ts">
	import Page from '$local/evidence/hoa_diff_tab/+page.svelte';
	import type { ComponentProps } from 'svelte';
	let { data }: { data: ComponentProps<typeof Page>['data'] } = $props();
</script>

<Page {data} />
