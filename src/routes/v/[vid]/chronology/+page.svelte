<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import DataGrid, { type Column } from '$lib/components/DataGrid.svelte';
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { dateBasis, money } from '$lib/components/format';
	import { allRows, clearFilters, excerptPreview, isFiltered, paramsFromQuery, queryFromParams, queryRows, statusChoices, statusLabel, type ChronologyQuery, type SortKey } from '$lib/local-case/chronology';
	import { docPath, type ChronologyListRow } from '$lib/local-case/model';
	import ChronologyPane from '$lib/views/evidence/ChronologyPane.svelte';
	import LocalOriginal from '$lib/views/evidence/LocalOriginal.svelte';
	import type { PageData } from './$types';
	// `original` shows a selected document's original in the pane: hosted passes its viewer; locally the page's `original`
	// action gives the document page's links to the isolated viewer.
	let { data, original }: { data: PageData; original?: Snippet<[string]> } = $props();
	const vid = $derived(data.version.id);
	// replaceState is shallow routing: page.url keeps the URL the page was loaded with, and Back restores that entry's
	// state, so the filters (and the open document) also travel in page.state and comparisons use the address bar.
	const initial = new URLSearchParams(page.state.chronology ?? page.url.search);
	let query = $state<ChronologyQuery>(queryFromParams(initial));
	let selected = $state<string | null>(initial.get('doc') || null);
	// Every row follows the first list page in the background. Page 1 is the list's first rows as stored, not as sorted:
	// rows on later pages (the undated ones, under the default date sort) sort ahead of it. So the list shows its rows only
	// once every row is in and their order is final; page 1 alone shows only when the rest failed to load, under a warning.
	let all = $state<ChronologyListRow[] | null>(null);
	let loadFailed = $state(false);
	const total = $derived(data.first.total);
	const loaded = $derived(all ?? data.first.rows);
	const complete = $derived(all !== null || data.first.pages <= 1);
	const settled = $derived(complete || loadFailed);
	const rows = $derived(queryRows(loaded, query));
	const filtered = $derived(isFiltered(query));
	const bundles = $derived(data.facets.bundles.map(([v]) => v));
	const types = $derived(data.facets.docTypes.map(([v]) => v));
	const years = $derived(data.facets.years.map(([v]) => v));
	const statuses = $derived(statusChoices(data.facets.textStatuses.map(([v]) => v)));
	const selectedRow = $derived(selected ? (loaded.find((r) => r.ref === selected) ?? null) : null);
	let pending: Promise<ChronologyListRow[]> | null = null;
	const loadAll = () => {
		if (all) return Promise.resolve(all);
		if (data.first.pages <= 1) return Promise.resolve(data.first.rows);
		loadFailed = false;
		pending ??= allRows(data.listHref, fetch).then((r) => (all = r), (e: unknown) => { pending = null; loadFailed = true; throw e; });
		return pending;
	};
	const sync = () => {
		const p = paramsFromQuery(query);
		if (selected) p.set('doc', selected);
		const s = p.toString();
		if (s !== new URLSearchParams(location.search).toString()) replaceState(`${page.url.pathname}${s ? `?${s}` : ''}`, { chronology: s });
	};
	const set = (k: 'q' | 'bundle' | 'type' | 'year' | 'status', v: string) => { query = { ...query, [k]: v }; sync(); };
	const sortBy = (k: string) => { query = query.sort === k ? { ...query, dir: query.dir === 1 ? -1 : 1 } : { ...query, sort: k as SortKey, dir: 1 }; sync(); };
	const clear = () => { query = clearFilters(query); sync(); };
	let main = $state<HTMLElement>();
	let split = $state<HTMLElement>();
	let pane = $state<HTMLElement>();
	// Below the split breakpoint an open pane sits under the list: opening a document moves to it. Side by side, the list
	// narrows when a document opens, so the row is kept in view. Closing returns to the row's Preview button.
	const stacked = () => !!split && getComputedStyle(split).gridTemplateColumns.split(' ').length < 2;
	const rowOf = (ref: string) => split?.querySelector<HTMLElement>(`.grid-row[data-ref="${CSS.escape(ref)}"]`);
	const select = async (r: ChronologyListRow) => {
		selected = r.ref;
		sync();
		await tick();
		if (stacked()) { pane?.scrollIntoView({ block: 'start' }); pane?.focus({ preventScroll: true }); }
		else rowOf(r.ref)?.scrollIntoView({ block: 'nearest' });
	};
	const close = async () => {
		const ref = selected;
		if (!ref) return;
		const below = stacked();
		selected = null;
		sync();
		await tick();
		const button = rowOf(ref)?.querySelector<HTMLButtonElement>('button.preview');
		button?.scrollIntoView({ block: below ? 'center' : 'nearest' });
		(button ?? main)?.focus({ preventScroll: true });
	};
	// Escape closes the document, as it closes the drawer and an inline confirmation, unless a text field has the key.
	const keys = (e: KeyboardEvent) => {
		const t = e.target as Element;
		if (e.key !== 'Escape' || !selected || e.defaultPrevented || (t !== document.body && !split?.contains(t)) || t.closest('input, select, textarea')) return;
		void close();
	};
	const showBasis = $derived(loaded.some((r) => r.dateType || r.dateSource));
	const basisLabel = (r: ChronologyListRow) => r.dateType ?? (r.dateSource ? `from ${r.dateSource}` : r.date ? 'unknown' : 'undated');
	const columns: Column[] = $derived([
		{ key: 'date', label: 'Date', sortable: true },
		...(showBasis ? [{ key: 'basis', label: 'Date basis' }] : []),
		{ key: 'ref', label: 'Ref', sortable: true },
		{ key: 'title', label: 'Title / subject' },
		{ key: 'docType', label: 'Type', sortable: true },
		{ key: 'bundle', label: 'Bundle', sortable: true },
		{ key: 'amount', label: 'Amount', sortable: true, align: 'end' },
		{ key: 'text', label: 'Status' },
		{ key: 'original', label: 'Original' },
	]);
	const cleanName = (s: string) => s.replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');
	const exportCsv = async () => {
		let source: ChronologyListRow[];
		try { source = await loadAll(); } catch { return; }
		const out = queryRows(source, query);
		const keys = ['ref', 'date', 'filename', 'subject', 'sender', 'to', 'doc_type', 'bundle', 'amount', 'also_in', 'text_status', 'url'];
		download(data.exportName.name, toCSV([keys, ...out.map((r) => [r.ref, r.date, r.filename, r.subject, r.sender, r.to, r.docType, r.bundle, r.amount, r.alsoIn, r.textStatus, r.url])]));
	};
	// Until every row is in, a filtered count would undercount, so the count says it is still loading.
	const count = $derived(complete ? rows.length : filtered ? null : total);
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
		void loadAll().catch(() => {});
	});
</script>

{#snippet localOriginal(ref: string)}<LocalOriginal {ref} />{/snippet}

<svelte:window onkeydown={keys} />

<main id="main" tabindex="-1" data-ready={mounted && settled ? 'chronology' : null} bind:this={main}>
	<PageHeader heading="Chronology" section="Chronology" caseName={data.version.titleName} subtitle="{total.toLocaleString('en')} items · sorted by date">
		{#snippet actions()}<button type="button" onclick={exportCsv} id="export-csv">Export CSV ({count === null ? '…' : count.toLocaleString('en')} rows)</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}{/snippet}
	</PageHeader>
	<DegradedRows failed={data.failed} />
	<form class="filters" role="search" aria-label="Filter the chronology" onsubmit={(e) => e.preventDefault()}>
		<label>Text, ref or filename<br /><input id="f-q" value={query.q} oninput={(e) => set('q', e.currentTarget.value)} /></label>
		<label>Bundle<br /><select id="f-bundle" value={query.bundle} onchange={(e) => set('bundle', e.currentTarget.value)}><option value="">All bundles</option>{#each bundles as b (b)}<option value={b}>{b}</option>{/each}</select></label>
		<label>Type<br /><select id="f-type" value={query.type} onchange={(e) => set('type', e.currentTarget.value)}><option value="">All types</option>{#each types as t (t)}<option value={t}>{t}</option>{/each}</select></label>
		<label>Year<br /><select id="f-year" value={query.year} onchange={(e) => set('year', e.currentTarget.value)}><option value="">All years</option>{#each years as y (y)}<option value={y}>{y}</option>{/each}</select></label>
		<label>Text status<br /><select id="f-status" value={query.status} onchange={(e) => set('status', e.currentTarget.value)}><option value="">Any text status</option>{#each statuses as s (s)}<option value={s}>{s}</option>{/each}</select></label>
		<span id="row-count" role="status" aria-live="polite" data-count={count ?? undefined} data-complete={complete}>{#if count === null}Loading every document to filter…{:else}{count.toLocaleString('en')} of {total.toLocaleString('en')} documents{/if}</span>
	</form>
	{#if loadFailed}<p class="load-failed" role="alert">Only the first {loaded.length.toLocaleString('en')} documents are loaded. <button type="button" onclick={() => void loadAll().catch(() => {})}>Load the rest</button></p>{/if}
	<div class="chrono-split-box">
		<div class="chrono-split" class:open={!!selected} bind:this={split}>
			<div class="chrono chrono-list" data-testid="chronology-list" aria-busy={settled ? undefined : 'true'}>
				{#if !settled}
					<p class="list-loading card" role="status">Loading the chronology…</p>
				{:else if complete && rows.length === 0}
					<div class="no-match card" role="status"><p>No documents match these filters.</p><button type="button" onclick={clear}>Clear filters</button></div>
				{:else}
					<DataGrid {columns} {rows} rowKey={(r: ChronologyListRow) => r.ref} label="Chronology" gridClass={showBasis ? 'chrono-grid chrono-sel' : 'chrono-grid chrono-sel no-basis'} sort={{ key: query.sort, dir: query.dir }} onsort={sortBy} rowAttrs={(r: ChronologyListRow) => ({ 'data-ref': r.ref })}
						onselect={(r: ChronologyListRow) => void select(r)} {selected} previewLabel={(r: ChronologyListRow) => `Preview ${r.ref}`} firstRows={50}>
						{#snippet cell(r: ChronologyListRow, c: Column)}
							{#if c.key === 'date'}{r.date || 'undated'}
							{:else if c.key === 'basis'}<span title={dateBasis(r)} data-date-basis={r.dateType || r.dateSource ? 'supplied' : r.date ? 'unknown' : 'undated'}>{basisLabel(r)}</span>
							{:else if c.key === 'ref'}<a class="cite" href={docPath(vid, r.ref, null, data.base)}>{r.ref}</a>{#if r.parentRef}<small> in {r.parentRef}</small>{/if}
							{:else if c.key === 'title'}<span class="clip" title={r.subject || r.filename}>{r.subject || cleanName(r.filename)}{#if r.sender}<small class="sender"> — {r.sender}</small>{/if}</span>{#if r.excerpt}<span class="clip excerpt">{excerptPreview(r.excerpt)}</span>{/if}{#if r.alsoIn.length}<small class="also-in">also in: {r.alsoIn.join(', ')}</small>{/if}
							{:else if c.key === 'docType'}{r.docType}
							{:else if c.key === 'bundle'}{r.bundle}
							{:else if c.key === 'amount'}{money(r.amount)}
							{:else if c.key === 'text'}{statusLabel(r.textStatus)}
							{:else}<span class={r.file === 'present' ? 'ok' : 'unresolved'} data-file={r.file}>{r.file === 'present' ? (r.preview === 'download' ? 'download' : 'open') : r.file}</span>{/if}
						{/snippet}
					</DataGrid>
				{/if}
			</div>
			<div class="chrono-divider" aria-hidden="true"></div>
			<ChronologyPane row={selectedRow} {selected} notFound={complete && !!selected && !selectedRow} docHref={selected ? docPath(vid, selected, null, data.base) : null} original={original ?? localOriginal} onclose={close} bind:pane />
		</div>
	</div>
</main>

<style>
	/* Tracks in px: the headings are set smaller than the cells, so em tracks would start each heading left of its column.
	   The table is at least as wide as its tracks, so a narrow list scrolls sideways to its last column. */
	:global(.chrono-grid.chrono-sel) { min-width: min-content; }
	:global(.chrono-grid.chrono-sel .grid-row) { column-gap: 6px; grid-template-columns: 65px 70px 70px 75px minmax(91px, 1fr) 65px 73px 70px 62px 64px; }
	:global(.chrono-grid.chrono-sel.no-basis .grid-row) { grid-template-columns: 65px 70px 75px minmax(91px, 1fr) 65px 73px 70px 62px 64px; }
	/* With the title column at its minimum, a heading wraps rather than running into the next one. */
	:global(.chrono-grid .grid-head > [role='columnheader']) { white-space: normal; min-width: 0; }
	:global(.chrono-grid .preview-cell button) { white-space: nowrap; min-height: 0; height: auto; padding: 2px 6px; font-size: 12px; }
	:global(.chrono-grid .grid-row.selected .cite) { font-weight: 600; }
	.excerpt, .also-in { display: block; }
	.chrono-split-box { container-type: inline-size; }
	/* The list takes the full width until a document opens. Then the two sit side by side when there is room for both
	   columns' minimums; otherwise the pane sits below the list, full width. */
	.chrono-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
	.chrono-list { min-width: 0; }
	.chrono-list :global(.table-scroll) { max-height: 70vh; overflow: auto; }
	.chrono-divider, .chrono-split :global(.chrono-pane:not([data-ref])) { display: none; }
	.list-loading { margin: 0; padding: 20px; }
	@container (min-width: 960px) {
		.chrono-split { height: calc(100vh - 206px); min-height: 520px; }
		.chrono-split.open { grid-template-columns: minmax(600px, 1fr) 8px minmax(340px, 38%); gap: 0; }
		.chrono-list { display: flex; flex-direction: column; min-height: 0; }
		.chrono-list :global(.table-scroll) { max-height: none; flex: 1 1 auto; min-height: 0; }
		.chrono-split.open .chrono-divider { display: block; background: var(--border); width: 1px; justify-self: center; }
		.chrono-split :global(.chrono-pane) { min-height: 0; }
	}
	@container (max-width: 959.98px) {
		/* Below the list, the pane's close control reads Back to list. */
		.chrono-split :global(.chrono-pane .pane-back) { justify-content: flex-start; }
		.chrono-split :global(.chrono-pane .pane-close-wide) { display: none; }
		.chrono-split :global(.chrono-pane .pane-close-narrow) { display: inline; }
		/* Touch targets (GRS-272): Preview, a citation and a sort button are 44 px each way, like Back to list. */
		.chrono-split :global(.chrono-grid .preview-cell button), .chrono-split :global(.chrono-grid .grid-head button), .chrono-split :global(.chrono-pane .pane-back button) { min-height: 44px; min-width: 44px; }
		.chrono-split :global(.chrono-grid .grid-head button) { display: inline-flex; align-items: center; }
		.chrono-split :global(.chrono-grid [role='cell'] a.cite) { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; }
	}
	.no-match { padding: 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
	.no-match p { margin: 0; }
</style>
