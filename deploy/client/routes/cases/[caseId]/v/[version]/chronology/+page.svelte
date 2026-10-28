<script lang="ts">
	import Page from '$local/chronology/+page.svelte';
	import type { ComponentProps } from 'svelte';
	import HostedOriginal from './HostedOriginal.svelte';
	let { data }: { data: ComponentProps<typeof Page>['data'] & { originalBase: string } } = $props();
</script>

{#snippet original(ref: string)}<HostedOriginal href="{data.originalBase}/{encodeURIComponent(ref)}" />{/snippet}
<Page {data} {original} />
