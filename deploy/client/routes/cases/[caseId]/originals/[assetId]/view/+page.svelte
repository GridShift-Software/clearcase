<script lang="ts">
	import PdfViewer from '$lib/viewer/hosted/PdfViewer.svelte';
	import type { OriginalView } from '$lib/viewer/hosted/view-model';
	import type { PageNote } from '$lib/viewer/hosted/page-notes';
	let { data }: { data: { caseId: string; assetId: string; view: OriginalView; notes: { state: 'available' | 'unavailable'; items: readonly PageNote[] }; notesHref: string; requestedPage?: string | null } } = $props();
	const REASON = { missing: 'This original is no longer available.', changed: 'This original failed its integrity check, so it is not shown.', embedded: 'This original is part of another file.' } as const;
</script>

<style>
	h1, p { overflow-wrap: anywhere; }
</style>

<h1 data-asset-id={data.assetId}>{data.view.filename ?? 'Original'}</h1>
{#if data.view.state === 'unavailable'}
	<p role="alert" data-viewer-state="unavailable" data-reason={data.view.reason}>{REASON[data.view.reason]}</p>
{:else if data.view.mode === 'pdf'}
	<!-- A fresh authorized load replaces all document-bound state, even for the same URL after an original changes.
	     Key the load object rather than exposing a content hash or object-storage identity to the client. -->
	{#key data}
		<PdfViewer requestedPage={data.requestedPage ?? null} src={data.view.srcHref} downloadHref={data.view.downloadHref} notesHref={data.notesHref} notes={data.notes.items} notesAvailable={data.notes.state === 'available'} />
	{/key}
{:else if data.view.mode === 'image'}
	<img data-viewer-state="image" src={data.view.srcHref} alt={data.view.filename} style="max-width: 100%" referrerpolicy="no-referrer" />
	<p><a data-action="download-original" href={data.view.downloadHref}>Download the original</a></p>
{:else}
	<p data-viewer-state="download-only">This file type is not shown in the app. <a data-action="download-original" href={data.view.downloadHref}>Download the original</a> ({data.view.mediaType}, {data.view.size} bytes).</p>
{/if}
