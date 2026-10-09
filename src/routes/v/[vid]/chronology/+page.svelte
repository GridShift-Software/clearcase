<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import DataGrid, { type Column } from '$lib/components/DataGrid.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { dateBasis, money } from '$lib/components/format';
	import { optionsOf, paramsFromQuery, queryFromParams, queryRows, type ChronologyQuery, type SortKey } from '$lib/local-case/chronology';
	import { docPath, type ChronologyListRow } from '$lib/local-case/model';
	let { data } = $props();
	const vid = $derived(data.version.id);
	let query = $state<ChronologyQuery>(queryFromParams(page.url.searchParams));
	const rows = $derived(queryRows(data.rows, query));
	const bundles = $derived(optionsOf(data.rows, 'bundle'));
	const types = $derived(optionsOf(data.rows, 'docType'));
	const statuses = $derived(optionsOf(data.rows, 'textStatus'));
	// Filters live in the URL (replaced, not pushed), so Back from a document returns to the same filtered list.
	const sync = () => {
		const p = paramsFromQuery(query).toString();
		if (p !== page.url.searchParams.toString()) replaceState(`${page.url.pathname}${p ? `?${p}` : ''}`, {});
	};
	const set = (k: 'q' | 'bundle' | 'type' | 'status', v: string) => { query = { ...query, [k]: v }; sync(); };
	const sortBy = (k: string) => { query = query.sort === k ? { ...query, dir: query.dir === 1 ? -1 : 1 } : { ...query, sort: k as SortKey, dir: 1 }; sync(); };
	const columns: Column[] = [
		{ key: 'date', label: 'Date', width: '6.5em', sortable: true },
		{ key: 'basis', label: 'Date basis', width: '7em' },
		{ key: 'ref', label: 'Ref', width: '7.5em', sortable: true },
		{ key: 'title', label: 'Title / subject', width: 'minmax(0, 1fr)' },
		{ key: 'docType', label: 'Type', width: '9em', sortable: true },
		{ key: 'bundle', label: 'Bundle', width: '8em', sortable: true },
		{ key: 'amount', label: 'Amount', width: '8em', sortable: true, align: 'end' },
		{ key: 'text', label: 'Text', width: '6em' },
		{ key: 'original', label: 'Original', width: '6em' },
	];
	const cleanName = (s: string) => s.replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');
	const exportCsv = () => {
		const keys = ['ref', 'date', 'filename', 'subject', 'sender', 'to', 'doc_type', 'bundle', 'amount', 'also_in', 'text_status', 'url'];
		download('chronology.csv', toCSV([keys, ...rows.map((r) => [r.ref, r.date, r.filename, r.subject, r.sender, r.to, r.docType, r.bundle, r.amount, r.alsoIn, r.textStatus, r.url])]));
	};
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'chronology' : null}>
	<PageHeader heading="Chronology" section="Chronology" caseName={data.version.caseName} subtitle="{data.rows.length.toLocaleString('en')} documents in source order of the register; dates as the source gives them">
		{#snippet actions()}<button type="button" onclick={exportCsv} id="export-csv">Export CSV ({rows.length.toLocaleString('en')} rows)</button>{/snippet}
	</PageHeader>
	<form class="filters" role="search" aria-label="Filter the chronology" onsubmit={(e) => e.preventDefault()}>
		<label>Text, ref or filename<br /><input id="f-q" value={query.q} oninput={(e) => set('q', e.currentTarget.value)} /></label>
		<label>Bundle<br /><select id="f-bundle" value={query.bundle} onchange={(e) => set('bundle', e.currentTarget.value)}><option value="">All bundles</option>{#each bundles as b (b)}<option value={b}>{b}</option>{/each}</select></label>
		<label>Type<br /><select id="f-type" value={query.type} onchange={(e) => set('type', e.currentTarget.value)}><option value="">All types</option>{#each types as t (t)}<option value={t}>{t}</option>{/each}</select></label>
		<label>Text status<br /><select id="f-status" value={query.status} onchange={(e) => set('status', e.currentTarget.value)}><option value="">Any text status</option>{#each statuses as s (s)}<option value={s}>{s}</option>{/each}</select></label>
		<span id="row-count" role="status" aria-live="polite" data-count={rows.length}>{rows.length.toLocaleString('en')} of {data.rows.length.toLocaleString('en')} documents</span>
	</form>
	<div class="chrono">
		<DataGrid {columns} {rows} rowKey={(r: ChronologyListRow) => r.ref} label="Chronology" sort={{ key: query.sort, dir: query.dir }} onsort={sortBy} rowAttrs={(r: ChronologyListRow) => ({ 'data-ref': r.ref })}>
			{#snippet cell(r: ChronologyListRow, c: Column)}
				{#if c.key === 'date'}{r.date || 'undated'}
				{:else if c.key === 'basis'}<span title={dateBasis(r)} data-date-basis={r.dateType ? 'supplied' : r.date ? 'unknown' : 'undated'}>{r.dateType ?? (r.date ? 'unknown' : 'undated')}</span>
				{:else if c.key === 'ref'}<a href={docPath(vid, r.ref)}>{r.ref}</a>{#if r.parentRef}<small> in {r.parentRef}</small>{/if}
				{:else if c.key === 'title'}<span class="clip" title={r.subject || r.filename}>{r.subject || cleanName(r.filename)}{#if r.sender}<small> — {r.sender}</small>{/if}</span>
				{:else if c.key === 'docType'}{r.docType}
				{:else if c.key === 'bundle'}{r.bundle}
				{:else if c.key === 'amount'}{money(r.amount)}
				{:else if c.key === 'text'}{r.textStatus}
				{:else}<span class={r.file === 'present' ? 'ok' : 'unresolved'} data-file={r.file}>{r.file === 'present' ? (r.preview === 'download' ? 'download' : 'open') : r.file}</span>{/if}
			{/snippet}
		</DataGrid>
	</div>
</main>
