<script lang="ts">
	// The native PDF reader for a protected original. pdf.js is the pinned local package, served from this origin
	// (/pdfjs/, copied at build by the parent): no CDN, no external document service, no export of the file. The bytes
	// arrive through the original's own route with `fetch` (Sec-Fetch-Dest: empty, the only destination that gets the inline
	// form) and ranges; a refusal there ends in the download link, never a blank page. Page notes are saved through the
	// notes endpoint into user work; nothing is kept in the browser.
	import { onMount, untrack } from 'svelte';
	import type { PageNote } from './page-notes';
	let { src, downloadHref, notesHref, notes: initial, notesAvailable, requestedPage = null }: { src: string; downloadHref: string; notesHref: string; notes: readonly PageNote[]; notesAvailable: boolean; requestedPage?: string | null } = $props();
	const READER = '/pdfjs/pdf-reader.mjs';
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let pages = $state(0);
	let current = $state(1);
	let pageError = $state('');
	let scale = $state(1.2);
	let viewport = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let notes = $state<PageNote[]>(untrack(() => [...initial]));
	let draft = $state('');
	let noteError = $state('');
	let pending = $state(false);
	let draftRevision = 0;
	type Reader = { pages: number; draw(page: number, scale: number, fitWidth?: number): Promise<void>; destroy(): void };
	type Global = { clearcasePdfReader?: { open(a: { src: string; canvas: HTMLCanvasElement; signal: AbortSignal }): Promise<Reader> } };
	let reader: Reader | null = null;
	let active = false;
	let drawGeneration = 0;
	const lifetime = new AbortController();
	// Retry identity belongs to exactly one draft/page, never to subsequent text or another mounted original.
	let retry: { revision: number; page: number; body: string; operationId: string } | null = null;
	const deleteRetries = new Map<string, string>();

	// The adapter is a static module next to pdf.js (not in the Worker bundle): loaded once from this origin, then asked to open the file.
	function adapter(): Promise<NonNullable<Global['clearcasePdfReader']>> {
		const g = window as unknown as Global;
		if (g.clearcasePdfReader) return Promise.resolve(g.clearcasePdfReader);
		return new Promise((resolve, reject) => {
			const s = document.createElement('script');
			const cleanup = () => {
				window.removeEventListener('clearcase:pdf-reader', loaded);
				lifetime.signal.removeEventListener('abort', failed);
				s.onerror = null;
				s.remove();
			};
			const failed = () => { cleanup(); reject(new Error('reader')); };
			const loaded = () => { cleanup(); if (g.clearcasePdfReader) resolve(g.clearcasePdfReader); else reject(new Error('reader')); };
			window.addEventListener('clearcase:pdf-reader', loaded, { once: true });
			lifetime.signal.addEventListener('abort', failed, { once: true });
			s.type = 'module';
			s.src = READER;
			s.onerror = failed;
			document.head.append(s);
		});
	}
	const draw = () => {
		const r = reader, generation = ++drawGeneration;
		const width = viewport?.clientWidth;
		return active && r && canvas ? (width ? r.draw(current, scale, width) : r.draw(current, scale)).catch(() => {
			if (active && r === reader && generation === drawGeneration) status = 'error';
		}) : Promise.resolve();
	};
	onMount(() => {
		active = true;
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (reader) void draw(); });
		if (viewport) observer?.observe(viewport);
		// The route keys this component by its authorized load. Capture the source before any await.
		const source = src, target = canvas!;
		adapter()
			.then((a) => active ? a.open({ src: source, canvas: target, signal: lifetime.signal }) : null)
			.then(async (r) => {
				if (!r) return;
				if (!active) return r.destroy();
				reader = r;
				pages = r.pages;
				if (requestedPage !== null) {
					const number = parsePage(requestedPage);
					if (number !== null && number <= pages) current = number;
					else pageError = pageMessage(requestedPage);
				}
				status = 'ready';
				await draw();
			})
			.catch(() => { if (active) status = 'error'; });
		return () => { observer?.disconnect(); active = false; drawGeneration++; lifetime.abort(); reader?.destroy(); reader = null; };
	});
	const parsePage = (value: string) => {
		if (!/^\d+$/.test(value)) return null;
		const number = Number(value);
		return Number.isSafeInteger(number) && number > 0 ? number : null;
	};
	const pageMessage = (value: string) => `Page ${value || '(empty)'} is invalid or doesn't exist; this document has ${pages} ${pages === 1 ? 'page' : 'pages'}.`;
	const go = (n: number) => { pageError = ''; current = n; void draw(); };
	const enterPage = (input: HTMLInputElement) => {
		const value = input.value, number = parsePage(value);
		if (number === null || number > pages) {
			pageError = pageMessage(value);
			input.value = String(current);
			return;
		}
		go(number);
	};
	const zoom = (f: number) => { scale = Math.min(4, Math.max(0.4, scale * f)); void draw(); };
	const operation = () => `note-${crypto.randomUUID()}`;
	async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>) {
		noteError = '';
		try {
			const r = await fetch(notesHref, { method, headers: { 'content-type': 'application/json' }, credentials: 'same-origin', signal: lifetime.signal, body: JSON.stringify(body) });
			if (!active) return null;
			if (!r.ok) { noteError = r.status === 409 ? 'This note changed elsewhere. Reload and try again.' : 'The note was not saved.'; return null; }
			const out = await r.json();
			return active ? out : null;
		} catch {
			if (active) noteError = 'The note was not saved.';
			return null;
		}
	}
	async function add() {
		if (!active || pending || status !== 'ready' || !notesAvailable) return;
		const revision = draftRevision, page = current, body = draft;
		if (!retry || retry.revision !== revision || retry.page !== page || retry.body !== body) retry = { revision, page, body, operationId: operation() };
		pending = true;
		try {
			const out = await send('POST', { page, body, operationId: retry.operationId });
			if (active && out?.note) {
				notes = [...notes.filter((n) => n.rowId !== out.note.rowId), out.note].sort((a, b) => a.page - b.page);
				if (draftRevision === revision) draft = '';
				retry = null;
			}
		} finally { if (active) pending = false; }
	}
	async function remove(n: PageNote) {
		if (!active || pending || !notesAvailable) return;
		const key = JSON.stringify([n.rowId, n.version]);
		const operationId = deleteRetries.get(key) ?? operation();
		deleteRetries.set(key, operationId);
		pending = true;
		try {
			if (await send('DELETE', { rowId: n.rowId, version: n.version, operationId })) {
				if (active) notes = notes.filter((x) => x.rowId !== n.rowId);
				deleteRetries.delete(key);
			}
		} finally { if (active) pending = false; }
	}
</script>

<div data-viewer-state={status} data-viewer="pdf">
	{#if status === 'error'}
		<p role="alert">This file cannot be displayed here. <a data-action="download-original" href={downloadHref}>Download the original</a>.</p>
	{:else}
		<p>
			<button type="button" onclick={() => go(current - 1)} disabled={status !== 'ready' || current <= 1}>Previous</button>
			<label>Page <input type="number" min="1" max={pages || 1} value={current} onchange={(e) => enterPage(e.currentTarget)} disabled={status !== 'ready'} /></label> of {pages || '…'}
			<button type="button" onclick={() => go(current + 1)} disabled={status !== 'ready' || current >= pages}>Next</button>
			<button type="button" onclick={() => zoom(0.8)} disabled={status !== 'ready'}>Zoom out</button>
			<button type="button" onclick={() => zoom(1.25)} disabled={status !== 'ready'}>Zoom in</button>
			<a data-action="download-original" href={downloadHref}>Download</a>
		</p>
		{#if pageError}<p role="alert">{pageError}</p>{/if}
		<div class="pdf-viewport" bind:this={viewport}><canvas bind:this={canvas} aria-label={`Page ${current}`}></canvas></div>
	{/if}
</div>

<section aria-labelledby="page-notes" data-notes-state={notesAvailable ? 'available' : 'unavailable'}>
	<h2 id="page-notes">Notes on this original</h2>
	{#if !notesAvailable}
		<p>Notes are unavailable right now. The document is still readable.</p>
	{:else}
		<ul>
			{#each notes as n (n.rowId)}
				<li data-page={n.page}>Page {n.page}: {n.body}{n.current ? '' : ' (the original has changed since this note)'} <button type="button" onclick={() => remove(n)} disabled={pending}>Delete</button></li>
			{:else}
				<li>No notes yet.</li>
			{/each}
		</ul>
		<form onsubmit={(e) => { e.preventDefault(); void add(); }}>
			<label>Note on page {current} <textarea bind:value={draft} oninput={() => { draftRevision++; }} maxlength="2000" required></textarea></label>
			<button type="submit" disabled={pending || status !== 'ready'}>Save note</button>
		</form>
		{#if noteError}<p role="alert">{noteError}</p>{/if}
	{/if}
</section>

<style>
	.pdf-viewport { max-width: 100%; overflow-x: auto; }
	section { overflow-wrap: anywhere; }
	textarea { max-width: 100%; }
</style>
