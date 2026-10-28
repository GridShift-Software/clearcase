<script lang="ts">
	// The chronology's document pane, beside the list (below it on a narrow screen). It names the selected document, links
	// to its document page and shows its original: through `original` where the app can show it in the page (hosted), and
	// otherwise as a state. A missing, blocked or download-only original is said in words, never a blank viewer.
	import type { Snippet } from 'svelte';
	import { statusLabel } from '../../local-case/chronology.ts';
	import type { ChronologyListRow } from '../../local-case/model.ts';
	let { row, selected, docHref, original, onback, notFound = false, pane = $bindable() }: {
		row: ChronologyListRow | null; selected: string | null; docHref: string | null; original?: Snippet<[string]>; onback: () => void;
		/** Every row is loaded and none is `selected`. */
		notFound?: boolean; pane?: HTMLElement;
	} = $props();
	const title = (r: ChronologyListRow) => r.subject || r.filename.replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');
</script>

<section class="chrono-pane card" data-testid="chronology-document-pane" data-ref={selected || undefined} aria-labelledby="chrono-pane-h" tabindex="-1" bind:this={pane}>
	<p class="pane-back"><button type="button" onclick={onback}>Back to list</button></p>
	{#if !selected}
		<h2 id="chrono-pane-h" class="visually-hidden">Document</h2>
		<p class="pane-state" data-pane-state="none">Select a document in the list, or use its Preview button, to see it here.</p>
	{:else if !row}
		<h2 id="chrono-pane-h">{selected}</h2>
		{#if notFound}<p class="pane-state" data-pane-state="not-found">{selected} is not a document of this results version.</p>
		{:else}<p class="pane-state" data-pane-state="loading" role="status">Loading the document…</p>{/if}
	{:else}
		<header>
			<h2 id="chrono-pane-h" class="pane-title">{title(row)}</h2>
			<p class="pane-meta"><strong>{row.ref}</strong> · {row.date || 'undated'} · {row.docType} · {row.bundle} · text {statusLabel(row.textStatus)}{#if row.sender} · {row.sender}{/if}</p>
			{#if row.excerpt}<p class="pane-excerpt">{row.excerpt}</p>{/if}
			{#if row.alsoIn.length}<p class="pane-meta">Also in: {row.alsoIn.join(', ')}</p>{/if}
			{#if docHref}<p class="pane-links"><a href={docHref} data-action="open-document">Open document page</a></p>{/if}
		</header>
		{#if row.file !== 'present'}
			<p class="pane-state" data-pane-state="missing" data-file={row.file}>{row.file === 'blocked' ? 'This original is withheld, so it is not shown.' : 'The original of this document is missing from the case.'}</p>
		{:else if original}
			{@render original(row.ref)}
		{:else if row.preview === 'download'}
			<p class="pane-state" data-pane-state="download-only">This original is offered only as a download. Open the document page to download it.</p>
		{:else}
			<p class="pane-state" data-pane-state="local">The original opens in the isolated viewer from the document page.</p>
		{/if}
	{/if}
</section>

<style>
	.chrono-pane { min-width: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
	.chrono-pane:focus { outline: none; }
	/* the page shows Back when the pane sits below the list */
	.pane-back { display: none; margin: 0; }
	.pane-title { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
	.pane-excerpt { margin: 0; font-size: 13px; max-height: 8.5em; overflow: auto; overflow-wrap: anywhere; }
	.pane-meta, .pane-links, .pane-state { margin: 0; font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
</style>
