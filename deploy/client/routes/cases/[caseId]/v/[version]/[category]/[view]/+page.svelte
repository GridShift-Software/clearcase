<script lang="ts">
	import Soon from '../+page.svelte';
	import type { ComponentProps } from 'svelte';
	let { data }: { data: ComponentProps<typeof Soon>['data'] } = $props();
</script>

<Soon {data} />
