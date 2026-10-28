<script lang="ts">
	import '$lib/../app.css';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	let { children }: { children: Snippet } = $props();
	// A case version's pages bring their own shell and main#main, as they do locally.
	const bare = $derived(page.route.id?.startsWith('/cases/[caseId]/v/[version]') ?? false);
</script>

{#if bare}
	{@render children()}
{:else}
	<div class="hosted-root">
		<header class="hosted"><a href="/cases">ClearCase</a></header>
		<main id="main" data-ready="true">{@render children()}</main>
	</div>
{/if}
