<script lang="ts">
	// The native PDF reader for a protected original. pdf.js is the pinned local package, served from this origin
	// (/pdfjs/, copied at build by the parent): no CDN, no external document service, no export of the file. The bytes
	// arrive through the original's own route with `fetch` (Sec-Fetch-Dest: empty, the only destination that gets the inline
	// form) and ranges; a refusal there ends in the download link, never a blank page. Page notes are saved through the
	// notes endpoint into user work; nothing is kept in the browser.
	import { onMount, untrack } from 'svelte';
	import type { PageNote } from './page-notes';
	let { src, downloadHref, notesHref, notes: initial, notesAvailable }: { src: string; downloadHref: string; notesHref: string; notes: readonly PageNote[]; notesAvailable: boolean } = $props();
	const READER = '/pdfjs/pdf-reader.mjs';
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let pages = $state(0);
	let current = $state(1);
	let scale = $state(1.2);
	let canvas = $state<HTMLCanvasElement>();
	let notes = $state<PageNote[]>(untrack(() => [...initial]));
	let draft = $state('');
	let noteError = $state('');
	type Reader = { pages: number; draw(page: number, scale: number): Promise<void>; destroy(): void };
	type Global = { clearcasePdfReader?: { open(a: { src: string; canvas: HTMLCanvasElement }): Promise<Reader> } };
	let reader: Reader | null = null;

	// The adapter is a static module next to pdf.js (not in the Worker bundle): loaded once from this origin, then asked to open the file.
	function adapter(): Promise<NonNullable<Global['clearcasePdfReader']>> {
		const g = window as unknown as Global;
		if (g.clearcasePdfReader) return Promise.resolve(g.clearcasePdfReader);
		return new Promise((resolve, reject) => {
			window.addEventListener('clearcase:pdf-reader', () => (g.clearcasePdfReader ? resolve(g.clearcasePdfReader) : reject(new Error('reader'))), { once: true });
			const s = document.createElement('script');
			s.type = 'module';
			s.src = READER;
			s.onerror = () => reject(new Error('reader'));
			document.head.append(s);
		});
	}
	const draw = () => (reader && canvas ? reader.draw(current, scale).catch(() => { status = 'error'; }) : Promise.resolve());
	onMount(() => {
		let gone = false;
		adapter()
			.then((a) => a.open({ src, canvas: canvas! }))
			.then(async (r) => {
				if (gone) return r.destroy();
				reader = r;
				pages = r.pages;
				status = 'ready';
				await draw();
			})
			.catch(() => { status = 'error'; });
		return () => { gone = true; reader?.destroy(); reader = null; };
	});
	const go = (n: number) => { current = Math.min(Math.max(1, Math.trunc(n) || 1), Math.max(pages, 1)); void draw(); };
	const zoom = (f: number) => { scale = Math.min(4, Math.max(0.4, scale * f)); void draw(); };
	const operation = () => `note-${crypto.randomUUID()}`;
	async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>) {
		noteError = '';
		const r = await fetch(notesHref, { method, headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ operationId: operation(), ...body }) });
		if (!r.ok) { noteError = r.status === 409 ? 'This note changed elsewhere. Reload and try again.' : 'The note was not saved.'; return null; }
		return r.json();
	}
	async function add() {
		const out = await send('POST', { page: current, body: draft });
		if (out?.note) { notes = [...notes, out.note].sort((a, b) => a.page - b.page); draft = ''; }
	}
	async function remove(n: PageNote) {
		if (await send('DELETE', { rowId: n.rowId, version: n.version })) notes = notes.filter((x) => x.rowId !== n.rowId);
	}
</script>

<div data-viewer-state={status} data-viewer="pdf">
	{#if status === 'error'}
		<p role="alert">This file cannot be displayed here. <a data-action="download-original" href={downloadHref}>Download the original</a>.</p>
	{:else}
		<p>
			<button type="button" onclick={() => go(current - 1)} disabled={status !== 'ready' || current <= 1}>Previous</button>
			<label>Page <input type="number" min="1" max={pages || 1} value={current} onchange={(e) => go(Number(e.currentTarget.value))} disabled={status !== 'ready'} /></label> of {pages || '…'}
			<button type="button" onclick={() => go(current + 1)} disabled={status !== 'ready' || current >= pages}>Next</button>
			<button type="button" onclick={() => zoom(0.8)} disabled={status !== 'ready'}>Zoom out</button>
			<button type="button" onclick={() => zoom(1.25)} disabled={status !== 'ready'}>Zoom in</button>
			<a data-action="download-original" href={downloadHref}>Download</a>
		</p>
		<canvas bind:this={canvas} aria-label={`Page ${current}`}></canvas>
	{/if}
</div>

<section aria-labelledby="page-notes" data-notes-state={notesAvailable ? 'available' : 'unavailable'}>
	<h2 id="page-notes">Notes on this original</h2>
	{#if !notesAvailable}
		<p>Notes are unavailable right now. The document is still readable.</p>
	{:else}
		<ul>
			{#each notes as n (n.rowId)}
				<li data-page={n.page}>Page {n.page}: {n.body}{n.current ? '' : ' (the original has changed since this note)'} <button type="button" onclick={() => remove(n)}>Delete</button></li>
			{:else}
				<li>No notes yet.</li>
			{/each}
		</ul>
		<form onsubmit={(e) => { e.preventDefault(); void add(); }}>
			<label>Note on page {current} <textarea bind:value={draft} maxlength="2000" required></textarea></label>
			<button type="submit">Save note</button>
		</form>
		{#if noteError}<p role="alert">{noteError}</p>{/if}
	{/if}
</section>
