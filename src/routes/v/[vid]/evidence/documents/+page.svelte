<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { docPath } from '$lib/local-case/model';
	import { MAX_TEXT, dateCell, docLabel, n, statusLabel } from '$lib/views/evidence/common';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const m = $derived(data.model);
	let q = $state(page.url.searchParams.get('q') ?? '');
	function go(change: { bundle?: string; q?: string; page?: number }) {
		const p = new URLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(change)) { if (v === '' || v === undefined || (k === 'page' && v === 1)) p.delete(k); else p.set(k, String(v)); }
		const s = p.toString();
		goto(`${page.url.pathname}${s ? `?${s}` : ''}`, { replaceState: true, reset: false });
	}
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="documents" data-hydrated={ready ? '1' : null} data-busy={navigating.to ? 'true' : null} data-page={m.page.page} data-bundle={m.bundle} data-q={m.q}>
	<PageHeader heading="Documents" section="Documents" caseName={data.version.titleName} subtitle="{n(data.total)} documents · by bundle then type" />
	<DegradedRows failed={data.failed} />
	{#if m.unknownBundle}<p class="warning" id="unknown-bundle">The requested bundle is not in this results version; the first bundle is shown.</p>{/if}
	{#if m.filterTooLong}<p class="warning" id="filter-too-long">The filter is longer than {MAX_TEXT} characters, so it was not applied: every document of the bundle is shown.</p>{/if}
	{#if m.pageNotice}<p class="warning" id="page-notice">{m.pageNotice}</p>{/if}
	<div class="toolbar" role="group" aria-label="Bundle and filter">
		{#each m.bundles as b (b.value)}
			<button type="button" class={b.name === m.bundle ? 'primary' : 'sec'} aria-pressed={b.name === m.bundle} data-bundle={b.value} onclick={() => go({ bundle: b.value, page: 1 })}>{b.label} ({b.count})</button>
		{/each}
		<input class="in" id="doc-filter" placeholder="Filter in bundle" aria-label="Filter in bundle" maxlength={MAX_TEXT} bind:value={q} oninput={() => go({ q, page: 1 })} />
	</div>
	<div class="toolbar types" id="doc-types">{#each m.types as t (t.type)}<span class="badge">{t.type}: {t.count}</span>{/each}</div>
	<p class="note" id="doc-order">Ordered by type, then date (undated first). Types are imported classifications and have not been verified.</p>
	<div class="card pad0">
		<TableScroll label="Documents"><table class="tbl" id="documents-table">
			<thead><tr><th>Ref</th><th>Type</th><th>Date</th><th>Title</th><th class="num">Amount</th><th>Status</th><th>Doc</th></tr></thead>
			<tbody>
				{#each m.page.slice as r (r.ref)}
					<tr data-ref={r.ref}>
						<td class="mono">{r.ref}</td><td><span class="badge">{r.type}</span></td><td class="mono">{dateCell(r.date)}</td>
						<td>{r.title}</td><td class="num">{r.amount}</td><td>{statusLabel(r.textStatus)}</td>
						<td><a class="doc" href={docPath(vid, r.ref)}>{docLabel(r.file)}</a></td>
					</tr>
				{/each}
			</tbody>
		</table></TableScroll>
		<div class="pager" id="documents-pager">
			<button type="button" disabled={m.page.page <= 1} onclick={() => go({ page: m.page.page - 1 })}>Prev</button>
			<span>Page {m.page.page} / {m.page.pages}</span>
			<button type="button" disabled={m.page.page >= m.page.pages} onclick={() => go({ page: m.page.page + 1 })}>Next</button>
			<span class="count">Showing {m.page.from}–{m.page.to} of {n(m.page.total)}</span>
		</div>
	</div>
</main>

<style>
	.toolbar { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-bottom: .5rem; }
	.toolbar .in { margin-left: auto; max-width: 240px; }
</style>
