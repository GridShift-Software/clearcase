<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { docPath } from '$lib/local-case/model';
	import { NOT_SERVED } from '$lib/views/bundles/links';
	import { postAction } from '$lib/views/bundles/post';
	import { sizeLabel, uploadUrl } from '$lib/views/bundles/caselines';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const c = $derived(data.content);
	const pagesLabel = $derived(data.pages === null ? '' : data.pages.toLocaleString('en'));
	const bundleHref = (p: number | null = null) => (data.bundle ? docPath(vid, data.bundle.ref, p) : null);

	let q = $state(page.url.searchParams.get('q') ?? '');
	const search = () => goto(`?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`, { keepFocus: true, noScroll: true, replaceState: true });
	let pg = $state('');
	const goPage = () => { const n = parseInt(pg || '0', 10); const h = n >= 1 ? bundleHref(n) : null; if (h) goto(h); };

	// session uploads (S-caselines_tab-1 corrected): kept in this page only and offered as downloads. A file the user
	// adds never renders or runs on the app origin: its object URL is made from an application/octet-stream copy, never
	// from the file's own type, so opening the link, a new tab or a copied address only downloads it (CC-09-r2 D1).
	type Upload = { id: number; name: string; size: number; url: string };
	let uploads = $state<Upload[]>([]);
	let seq = 0;
	let dragging = $state(false);
	const addUploads = (files: FileList | null | undefined) => { for (const f of files ?? []) uploads.push({ id: ++seq, name: f.name, size: f.size, url: uploadUrl(f) }); };
	const removeUpload = (u: Upload) => { URL.revokeObjectURL(u.url); uploads = uploads.filter((x) => x.id !== u.id); };

	// Link and Remove each keep their own error: a success elsewhere never clears another action's failure. Link
	// snapshots the path it sent and clears the input only when it is unchanged, so text typed meanwhile stays.
	let path = $state('');
	let linkError = $state<string | null>(null);
	let removeErrors = $state<Record<string, string>>({});
	// `linking` alone gates Link and Retry; `unlinking` counts Removes in flight, so one finishing never re-enables a button for the other
	let linking = $state(false);
	let unlinking = $state(0);
	const busy = $derived(linking || unlinking > 0);
	const link = async () => {
		if (!path.trim() || linking) return;
		const sent = path;
		linking = true;
		const r = await postAction('link', [['path', sent]]).finally(() => { linking = false; });
		if (!r.ok) { linkError = r.message; return; }
		linkError = null;
		if (path === sent) path = '';
		await invalidateAll();
	};
	const unlink = async (id: string) => {
		unlinking++;
		const r = await postAction('unlink', [['id', id]]).finally(() => { unlinking--; });
		if (!r.ok) { removeErrors[id] = r.message; return; }
		delete removeErrors[id];
		await invalidateAll();
	};
	beforeNavigate((nav) => {
		if (nav.to?.route.id === nav.from?.route.id || (!path.trim() && !linkError && !Object.keys(removeErrors).length)) return;
		if (nav.type === 'leave' || !confirm('A file path is typed but not linked, or a change failed. Leave this page and lose it?')) nav.cancel();
	});
	// without JavaScript nothing here can search, link or add files, so every control renders disabled with a note
	let ready = $state(false);
	const off = $derived(!ready);
	onMount(() => { ready = true; });
	// page numbers the page-text index repeats: every hit renders and each repeat is flagged
	const repeatedPages = $derived.by(() => { const seen = new Set<number>(), dup = new Set<number>(); for (const h of data.search?.hits ?? []) (seen.has(h.p) ? dup : seen).add(h.p); return dup; });
</script>

<main id="main" tabindex="-1" data-ready="caselines_tab" data-hydrated={ready ? '1' : null} data-busy={busy ? '1' : '0'} aria-busy={busy}>
	<PageHeader heading="CaseLines" section="CaseLines" caseName={data.version.titleName} subtitle={c.subtitle ?? 'The consolidated court bundle — open, download, search, and add documents'} />
	{#if off}<p class="notice" id="cl-nojs">Search, go to page, linking and adding files need JavaScript, which is off or still loading; nothing on this page can be saved without it.</p>{/if}
	<div class="cl-hero">
		<div>{#if c.name}<div class="t">{c.name}</div>{/if}{#if c.note}<div class="m">{c.note}</div>{/if}</div>
		<div class="sp">
			{#if data.bundle}<a class="clb solid" href={bundleHref()} id="cl-open">Open in app</a><a class="clb" href={bundleHref()} target="_blank" rel="noopener" id="cl-newtab">Open in new tab</a>{#if data.downloads[data.bundle.ref]}<a class="clb" href={data.downloads[data.bundle.ref]} rel="noopener noreferrer" download id="cl-download">Download</a>{/if}
			{:else}<span class="not-served" id="cl-not-served">The bundle file is {NOT_SERVED}.</span>{/if}
		</div>
	</div>
	<p class="coverage" id="cl-coverage">{#if data.cover.indexed}Search covers the page-text index only: {data.cover.indexed.toLocaleString('en')} page{data.cover.indexed === 1 ? '' : 's'} indexed{data.pages !== null ? ` of ${pagesLabel}` : ''}, {data.cover.withoutText.toLocaleString('en')} without text{data.cover.withoutText ? ` (${data.cover.emptyPages.map((p) => `p.${p}`).join(', ')}${data.cover.withoutText > data.cover.emptyPages.length ? ', …' : ''})` : ''}. Words on pages without text, and in images, are not found.{:else}This package has no page-text index, so the bundle cannot be searched here.{/if}</p>

	<section class="cl-card" aria-labelledby="cl-search-h">
		<h2 class="hd" id="cl-search-h">🔎 Search the bundle</h2>
		<div class="cl-row">
			<input class="ds-in" id="cl-q" disabled={off} placeholder="Type a word or phrase, then Enter…" bind:value={q} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
			<button type="button" class="ds-btn pri" id="cl-go" disabled={off || !data.cover.indexed} onclick={search}>{data.cover.indexed ? `Search ${pagesLabel} pages` : 'Search unavailable (no page-text index)'}</button>
			<span class="cl-row goto">Go to page <input class="ds-in" id="cl-pg" disabled={off} type="number" min="1" max={data.pages ?? undefined} bind:value={pg} /> <button type="button" class="ds-btn" id="cl-goto" disabled={off} onclick={goPage}>Open</button></span>
		</div>
		<div id="cl-results" data-q={data.q}>
			{#if data.qTooLong}<div class="cl-hint error" id="cl-too-long">Not searched: a search is limited to 200 characters. Shorten it and search again.</div>
			{:else if data.q.trim() && !data.cover.indexed}<div class="cl-hint" id="cl-no-index">This package has no page-text index, so the bundle cannot be searched here.</div>
			{:else if data.search && data.q.trim()}
				{#if !data.search.total}<div class="cl-hint" id="cl-none">No pages contain “{data.q.trim()}”.</div>
				{:else}
					<div class="cl-hint" id="cl-summary"><b>{data.search.total}</b> page(s) · {data.search.occurrences} occurrence(s) of “{data.q.trim()}”. Click a result to open the bundle at that page.</div>
					<div class="cl-res">
						{#each data.search.hits as h, i (i)}<a class="cl-hit" href={bundleHref(h.p)} data-p={h.p}><span class="pg">p.{h.p}</span>{#if repeatedPages.has(h.p)}<span class="dup" title="The page-text index holds this page number more than once">repeated page</span>{/if}{h.pre}<mark>{h.mid}</mark>{h.post}{#if h.count > 1}{' '}<span class="n">({h.count}×)</span>{/if}</a>{/each}
						{#if data.search.total > 400}<div class="cl-hint">Showing first 400 pages — refine the search to narrow.</div>{/if}
					</div>
				{/if}
			{/if}
		</div>
	</section>

	<section class="cl-card" aria-labelledby="cl-add-h">
		<h2 class="hd" id="cl-add-h">📎 Add documents to CaseLines</h2>
		<div class="cl-drop" class:drag={dragging} id="cl-drop" role="region" aria-label="Drop files here"
			ondragenter={(e) => { e.preventDefault(); dragging = true; }} ondragover={(e) => { e.preventDefault(); dragging = true; }}
			ondragleave={(e) => { e.preventDefault(); dragging = false; }} ondrop={(e) => { e.preventDefault(); dragging = false; addUploads(e.dataTransfer?.files); }}>
			Drag &amp; drop files here, or <label class="browse">browse<input type="file" id="cl-file" disabled={off} multiple onchange={(e) => { addUploads(e.currentTarget.files); e.currentTarget.value = ''; }} /></label> to add them for this session (download only).</div>
		<div class="cl-row">
			<input class="ds-in" id="cl-path" disabled={off} placeholder="…or link a file already in the case folder, e.g. PLEADINGS &amp; NOTICES/Extra.pdf" bind:value={path} />
			<button type="button" class="ds-btn" id="cl-link" onclick={link} disabled={off || busy}>Link file (permanent)</button>{#if busy}<span class="saving" id="cl-saving" role="status">Saving…</span>{/if}
		</div>
		{#if linkError}<p class="error" role="alert" id="cl-error">{linkError} <button type="button" class="ds-btn" id="cl-retry" disabled={off || linking} onclick={link}>Retry</button></p>{/if}
		<div class="cl-hint">Linked files are remembered for this case and open through the document page when they are in the verified index. Files added for this session can only be downloaded while this page stays open; to keep one, save it into the case folder and link it by path.</div>
		<ul class="cl-doclist" id="cl-docs">
			{#each data.links as l (l.rowId)}<li data-row={l.rowId}><span class="nm" title={l.name}>📄 {l.name} <span class="dim">(linked)</span></span>{#if l.ref}<a href={docPath(vid, l.ref)}>Open</a>{#if data.downloads[l.ref]}<a href={data.downloads[l.ref]} rel="noopener noreferrer" download>Download</a>{/if}{:else}<span class="not-served">{NOT_SERVED}</span>{/if}<button type="button" class="rm" disabled={off} onclick={() => unlink(l.rowId)}>Remove</button>{#if removeErrors[l.rowId]}<span class="error" role="alert" data-remove-error={l.rowId}>{removeErrors[l.rowId]} <button type="button" class="ds-btn" onclick={() => unlink(l.rowId)}>Retry</button></span>{/if}</li>{/each}
			{#each uploads as u (u.id)}<li><span class="nm" title={u.name}>⬆️ {u.name} <span class="dim">(this session · {sizeLabel(u.size)})</span></span><a href={u.url} download={u.name}>Download</a><button type="button" class="rm" disabled={off} onclick={() => removeUpload(u)}>Remove</button></li>{/each}
			{#if !data.links.length && !uploads.length}<li class="dim">No additional documents yet.</li>{/if}
		</ul>
	</section>
</main>

<style>
	.cl-hero { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 0 0 12px; }
	.cl-hero .t { font-weight: 700; }
	.cl-hero .sp { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }
	.cl-card { border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; margin: 12px 0; }
	.cl-card .hd { font-size: 1rem; margin: 0 0 8px; }
	.cl-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
	.goto { margin-left: auto; }
	#cl-pg { max-width: 80px; }
	.cl-res { display: flex; flex-direction: column; max-height: 60vh; overflow: auto; }
	.cl-hit { display: block; padding: 4px 6px; border-bottom: 1px solid #eee; color: inherit; text-decoration: none; }
	.cl-hit .pg { font-weight: 700; margin-right: 6px; }
	.cl-hint, .dim, .coverage { color: #555; font-size: 0.9em; }
	.cl-drop { border: 2px dashed #bbb; padding: 14px; text-align: center; }
	.cl-drop.drag { border-color: #1d4ed8; }
	.browse { text-decoration: underline; cursor: pointer; font-weight: 700; }
	.browse input { display: none; }
	.cl-doclist li { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
	.cl-doclist .nm { overflow-wrap: anywhere; }
	.not-served { color: #92400e; font-style: italic; }
	.error { color: #b91c1c; }
	.saving { color: #92400e; font-weight: 700; }
	.dup { margin-right: 6px; font-size: 0.8em; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 0 4px; }
</style>
