<script lang="ts">
	import '$lib/../app.css';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	let { children }: { children: Snippet } = $props();
	// A case version's pages bring their own shell and main#main, as they do locally. An error there replaces the page and
	// its shell with the root error page, which then needs the hosted header and main around it.
	const bare = $derived(!page.error && (page.route.id?.startsWith('/cases/[caseId]/v/[version]') ?? false));
	// sign-in and sign-out are a narrow card; the case list and operator pages use the full width
	const narrow = $derived(/^\/sign-(in|out)/.test(page.route.id ?? ''));
</script>

{#if bare}
	{@render children()}
{:else}
	<div class="hosted-root">
		<header class="hosted"><a href="/cases">ClearCase</a></header>
		<main id="main" data-ready="true" class:narrow>{@render children()}</main>
	</div>
{/if}
