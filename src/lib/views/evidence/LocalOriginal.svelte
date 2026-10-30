<script lang="ts">
	// One document's own original in the local chronology's pane, from the page's `original` action: the links its document
	// page offers. The app cannot draw the original in its own page (its CSP allows only blob: frames and same-origin
	// fetches, and the originals site refuses to be framed), so the original opens in the isolated viewer in a new tab.
	// A missing, gone or download-only original each show their state. `loaded` seeds the answer without a request.
	import { deserialize } from '$app/forms';
	import type { LocalOriginal } from '../../local-case/chronology.ts';
	let { ref, loaded }: { ref: string; loaded?: LocalOriginal } = $props();
	let fetched = $state<LocalOriginal | 'loading' | 'error'>('loading');
	const shown = $derived(loaded ?? fetched);
	$effect(() => {
		if (loaded) return;
		const ctl = new AbortController(), body = new FormData();
		body.set('ref', ref);
		fetched = 'loading';
		fetch('?/original', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' }, signal: ctl.signal })
			.then((r) => r.text())
			.then((t) => {
				const r = deserialize(t);
				if (r.type !== 'success' || !r.data?.original) throw new Error(r.type);
				fetched = r.data.original as LocalOriginal;
			})
			.catch(() => { if (!ctl.signal.aborted) fetched = 'error'; });
		return () => ctl.abort();
	});
	const open = (o: LocalOriginal) => (o.links.presentation === 'viewer' ? o.links.viewer : o.links.presentation === 'inline' || o.links.presentation === 'text' ? o.links.open : null);
</script>

<div class="local-original" data-local-original={ref}>
	{#if shown === 'loading'}
		<p class="state" data-pane-state="loading" role="status">Loading the original…</p>
	{:else if shown === 'error'}
		<p class="state" data-pane-state="error" role="alert">The original cannot be reached from here right now. Open the document page to reach it.</p>
	{:else if !shown.links.download}
		<p class="state" data-pane-state="missing">{shown.onDisk ? `This original is not available now: ${shown.onDisk}.` : 'The original of this document is not available.'}</p>
	{:else if open(shown)}
		<p class="state" data-pane-state="local-original">The original opens in the isolated ClearCase viewer, in a new tab.</p>
		<p class="actions"><a class="btn primary" href={open(shown)} target="_blank" rel="noopener noreferrer" data-action="open-viewer">Open the original</a>
			<a class="btn" href={shown.links.download} rel="noopener noreferrer" data-action="download-original" download>Download</a></p>
	{:else}
		<p class="state" data-pane-state="download-only">This original is offered only as a download.</p>
		<p class="actions"><a class="btn" href={shown.links.download} rel="noopener noreferrer" data-action="download-original" download>Download the original</a></p>
	{/if}
</div>

<style>
	.local-original { display: flex; flex-direction: column; gap: 8px; }
	.state, .actions { margin: 0; font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
