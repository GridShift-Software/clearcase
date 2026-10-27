<script lang="ts">
	import type { Snippet } from 'svelte';
	import './hosted.css';
	let { children }: { children: Snippet } = $props();
</script>

<header class="hosted"><a href="/cases">ClearCase</a></header>
<main id="main" data-ready="true">{@render children()}</main>

<style>
	.hosted { min-height: var(--topbar); display: flex; align-items: center; padding: 0 1.5rem; background: var(--navy); font-weight: 600; }
	.hosted a { color: var(--surface); }
	main { padding: 1.5rem; max-width: 80rem; margin: 0 auto; }
</style>
