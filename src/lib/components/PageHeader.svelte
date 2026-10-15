<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pageTitle } from './titles.ts';
	let { heading, section, caseName = null, document = null, status = null, subtitle = null, actions }:
		{ heading: string; section: string; caseName?: string | null; document?: string | null; status?: string | null; subtitle?: string | null; actions?: Snippet } = $props();
</script>

<svelte:head><title>{pageTitle({ section, caseName, document, status })}</title></svelte:head>
<header class="page-head">
	<div>
		<h1 class="wrap" tabindex="-1" data-page-heading>{heading}</h1>
		{#if subtitle}<p class="subtitle wrap">{subtitle}</p>{/if}
	</div>
	{#if actions}<div class="page-actions">{@render actions()}</div>{/if}
</header>
