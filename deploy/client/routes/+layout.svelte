<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<header class="hosted"><a href="/cases">ClearCase</a></header>
<main id="main" data-ready="true">{@render children()}</main>

<style>
	.hosted { padding: 0.75rem 1rem; border-bottom: 1px solid #ccc; font-weight: 600; }
	main { padding: 1rem; max-width: 60rem; }
</style>
