<script lang="ts">
	// One document's original in the chronology's split pane: the hosted viewer's own model and component, loaded when the
	// pane opens a document. A missing, changed or embedded original and a download-only file each show their state.
	import PdfViewer from '$lib/viewer/hosted/PdfViewer.svelte';
	import type { OriginalView } from '$lib/viewer/hosted/view-model';
	let { href }: { href: string } = $props();
	type Loaded = { view: OriginalView; viewHref: string; notesHref: string };
	let state = $state<{ kind: 'loading' } | { kind: 'error' } | ({ kind: 'ready' } & Loaded)>({ kind: 'loading' });
	const REASON = { missing: 'This original is no longer available.', changed: 'This original failed its integrity check, so it is not shown.', embedded: 'This original is part of another file; open the document page to reach it.' } as const;
	$effect(() => {
		const ctl = new AbortController();
		state = { kind: 'loading' };
		fetch(href, { credentials: 'same-origin', signal: ctl.signal })
			.then((r) => (r.ok ? (r.json() as Promise<Loaded>) : Promise.reject(new Error(String(r.status)))))
			.then((b) => { state = { kind: 'ready', ...b }; })
			.catch(() => { if (!ctl.signal.aborted) state = { kind: 'error' }; });
		return () => ctl.abort();
	});
</script>

{#if state.kind === 'loading'}
	<p class="pane-state" data-pane-state="loading" role="status">Loading the original…</p>
{:else if state.kind === 'error'}
	<p class="pane-state" data-pane-state="error" role="alert">The original cannot be shown here right now. The list still works; try the document again.</p>
{:else if state.view.state === 'unavailable'}
	<p class="pane-state" data-pane-state="missing" data-reason={state.view.reason}>{REASON[state.view.reason]}</p>
{:else}
	<p class="pane-original"><span class="clip" title={state.view.filename}>{state.view.filename}</span> <a href={state.viewHref} data-action="open-viewer">Open full viewer</a></p>
	{#if state.view.mode === 'pdf'}
		{#key href}<PdfViewer src={state.view.srcHref} downloadHref={state.view.downloadHref} notesHref={state.notesHref} notes={[]} notesAvailable={false} />{/key}
	{:else if state.view.mode === 'image'}
		<img class="pane-image" src={state.view.srcHref} alt={state.view.filename} referrerpolicy="no-referrer" />
	{:else if state.view.mode === 'email'}
		<p class="pane-state" data-pane-state="email">This email opens in the full viewer. <a href={state.viewHref}>Open it</a> or <a data-action="download-original" href={state.view.downloadHref}>download the original</a>.</p>
	{:else}
		<p class="pane-state" data-pane-state="download-only">This file type is not shown in the app. <a data-action="download-original" href={state.view.downloadHref}>Download the original</a> ({state.view.mediaType}, {state.view.size.toLocaleString('en')} bytes).</p>
	{/if}
{/if}

<style>
	.pane-image { max-width: 100%; }
	.pane-original { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; margin: 0 0 8px; font-size: 13px; }
	.pane-original .clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
