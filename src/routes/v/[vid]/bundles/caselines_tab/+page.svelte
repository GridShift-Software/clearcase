<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { docPath } from '$lib/local-case/model';
	import { NOT_SERVED } from '$lib/views/bundles/links';
	import { postAction } from '$lib/views/bundles/post';
	import { sizeLabel } from '$lib/views/bundles/caselines';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const c = $derived(data.content);
	const pagesLabel = $derived(data.pages === null ? '' : data.pages.toLocaleString('en'));
	const bundleHref = (p: number | null = null) => (data.bundle ? docPath(vid, data.bundle.ref, p) : null);

	let q = $state(page.url.searchParams.get('q') ?? '');
	const search = () => goto(`?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`, { keepFocus: true, noScroll: true, replaceState: true });
	let pg = $state('');
	const goPage = () => { const n = parseInt(pg || '0', 10); const h = n >= 1 ? bundleHref(n) : null; if (h) goto(h); };

	// session uploads (S-caselines_tab-1 corrected): kept in this page only and offered as downloads; a file the user
	// adds is never opened in the app tab or rendered on the app origin
	type Upload = { id: number; name: string; size: number; url: string };
	let uploads = $state<Upload[]>([]);
	let seq = 0;
	let dragging = $state(false);
	const addUploads = (files: FileList | null | undefined) => { for (const f of files ?? []) uploads.push({ id: ++seq, name: f.name, size: f.size, url: URL.createObjectURL(f) }); };
	const removeUpload = (u: Upload) => { URL.revokeObjectURL(u.url); uploads = uploads.filter((x) => x.id !== u.id); };

	let path = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	const link = async () => {
		if (!path.trim()) return;
		busy = true;
		const r = await postAction('link', [['path', path]]);
		busy = false;
		if (!r.ok) { error = r.message; return; }
		error = null;
		path = '';
		await invalidateAll();
	};
	const unlink = async (id: string) => {
		busy = true;
		const r = await postAction('unlink', [['id', id]]);
		busy = false;
		if (!r.ok) { error = r.message; return; }
		error = null;
		await invalidateAll();
	};
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'caselines_tab' : null} data-busy={busy ? '1' : '0'}>
	<PageHeader heading="CaseLines" section="CaseLines" caseName={data.version.titleName} subtitle={c.subtitle ?? 'The consolidated court bundle — open, download, search, and add documents'} />
	<div class="cl-hero">
		<div>{#if c.name}<div class="t">{c.name}</div>{/if}{#if c.note}<div class="m">{c.note}</div>{/if}</div>
		<div class="sp">
			{#if data.bundle}<a class="clb solid" href={bundleHref()} id="cl-open">Open in app</a><a class="clb" href={bundleHref()} target="_blank" rel="noopener" id="cl-newtab">Open in new tab</a><a class="clb" href={bundleHref()} id="cl-download">Download</a>
			{:else}<span class="not-served" id="cl-not-served">The bundle file is {NOT_SERVED}.</span>{/if}
		</div>
	</div>
	<p class="coverage" id="cl-coverage">{#if data.cover.indexed}Search covers the page-text index only: {data.cover.indexed.toLocaleString('en')} page{data.cover.indexed === 1 ? '' : 's'} indexed{data.pages !== null ? ` of ${pagesLabel}` : ''}, {data.cover.withoutText.toLocaleString('en')} without text{data.cover.withoutText ? ` (${data.cover.emptyPages.map((p) => `p.${p}`).join(', ')}${data.cover.withoutText > data.cover.emptyPages.length ? ', …' : ''})` : ''}. Words on pages without text, and in images, are not found.{:else}This package has no page-text index, so the bundle cannot be searched here.{/if}</p>

	<section class="cl-card" aria-labelledby="cl-search-h">
		<h2 class="hd" id="cl-search-h">🔎 Search the bundle</h2>
		<div class="cl-row">
			<input class="ds-in" id="cl-q" placeholder="Type a word or phrase, then Enter…" bind:value={q} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
			<button type="button" class="ds-btn pri" id="cl-go" onclick={search}>Search {pagesLabel} pages</button>
			<span class="cl-row goto">Go to page <input class="ds-in" id="cl-pg" type="number" min="1" max={data.pages ?? undefined} bind:value={pg} /> <button type="button" class="ds-btn" id="cl-goto" onclick={goPage}>Open</button></span>
		</div>
		<div id="cl-results" data-q={data.q}>
			{#if data.search && data.q.trim()}
				{#if !data.search.total}<div class="cl-hint" id="cl-none">No pages contain “{data.q.trim()}”.</div>
				{:else}
					<div class="cl-hint" id="cl-summary"><b>{data.search.total}</b> page(s) · {data.search.occurrences} occurrence(s) of “{data.q.trim()}”. Click a result to open the bundle at that page.</div>
					<div class="cl-res">
						{#each data.search.hits as h (h.p)}<a class="cl-hit" href={bundleHref(h.p)} data-p={h.p}><span class="pg">p.{h.p}</span>{h.pre}<mark>{h.mid}</mark>{h.post}{#if h.count > 1}{' '}<span class="n">({h.count}×)</span>{/if}</a>{/each}
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
			Drag &amp; drop files here, or <label class="browse">browse<input type="file" id="cl-file" multiple onchange={(e) => { addUploads(e.currentTarget.files); e.currentTarget.value = ''; }} /></label> to add them for this session (download only).</div>
		<div class="cl-row">
			<input class="ds-in" id="cl-path" placeholder="…or link a file already in the case folder, e.g. PLEADINGS &amp; NOTICES/Extra.pdf" bind:value={path} />
			<button type="button" class="ds-btn" id="cl-link" onclick={link} disabled={busy}>Link file (permanent)</button>
		</div>
		{#if error}<p class="error" role="alert" id="cl-error">{error}</p>{/if}
		<div class="cl-hint">Linked files are remembered for this case and open through the document page when they are in the verified index. Files added for this session can only be downloaded while this page stays open; to keep one, save it into the case folder and link it by path.</div>
		<ul class="cl-doclist" id="cl-docs">
			{#each data.links as l (l.rowId)}<li data-row={l.rowId}><span class="nm" title={l.name}>📄 {l.name} <span class="dim">(linked)</span></span>{#if l.ref}<a href={docPath(vid, l.ref)}>Open</a><a href={docPath(vid, l.ref)}>Download</a>{:else}<span class="not-served">{NOT_SERVED}</span>{/if}<button type="button" class="rm" onclick={() => unlink(l.rowId)}>Remove</button></li>{/each}
			{#each uploads as u (u.id)}<li><span class="nm" title={u.name}>⬆️ {u.name} <span class="dim">(this session · {sizeLabel(u.size)})</span></span><a href={u.url} download={u.name}>Download</a><button type="button" class="rm" onclick={() => removeUpload(u)}>Remove</button></li>{/each}
			{#if !data.links.length && !uploads.length}<li class="dim">No additional documents yet.</li>{/if}
		</ul>
	</section>
</main>

<style>
	.cl-hero { display: flex; gap: 12px; align-items: center; margin: 0 0 12px; }
	.cl-hero .t { font-weight: 700; }
	.cl-hero .sp { margin-left: auto; display: flex; gap: 8px; }
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
	.cl-doclist li { display: flex; gap: 10px; align-items: center; }
	.not-served { color: #92400e; font-style: italic; }
	.error { color: #b91c1c; }
</style>
