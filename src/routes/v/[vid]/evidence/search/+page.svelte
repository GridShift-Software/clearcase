<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { docPath } from '$lib/local-case/model';
	import { MAX_TEXT, dateCell, docLabel, n } from '$lib/views/evidence/common';
	import { paramsOf } from '$lib/views/evidence/search';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const q = $derived(data.query);
	const r = $derived(data.result);
	const cov = $derived(data.coverage);
	/** The form's fields. A search that lands sets them to what it searched, except a field typed in while it was in
	 *  flight: that keeps the newer text. Any other navigation (a page, Back) sets a field only when its value changed. */
	type Q = typeof data.query;
	const KEYS = Object.keys(untrack(() => data.query)) as (keyof Q)[];
	let f = $state<Q>(untrack(() => ({ ...data.query })));
	let prev = untrack(() => data.query);
	let sent: Q | null = null;
	$effect(() => {
		const nq = data.query;
		untrack(() => {
			for (const k of KEYS) if (!(sent && f[k] !== sent[k]) && (sent || nq[k] !== prev[k])) f[k] = nq[k];
			prev = nq;
			sent = null;
		});
	});
	/** The submitted search with one change (a page, or the action items), replacing the URL entry. */
	function go(extra: Record<string, string>) {
		goto(`${page.url.pathname}?${paramsOf(q, extra)}`, { replaceState: true, keepFocus: true, noScroll: true });
	}
	let exportError = $state<string | null>(null);
	/** Export the submitted search (v5: the last collected state, not unsaved form edits). */
	async function exportCsv() {
		exportError = null;
		const s = data.submitted ? paramsOf(q).toString() : '';
		try {
			const res = await fetch(`${page.url.pathname}/export${s ? `?${s}` : ''}`);
			if (!res.ok) { exportError = `The export failed: ${(await res.text()).slice(0, 200)}`; return; }
			download(data.exportName.name, await res.text());
		} catch { exportError = 'The export failed: the app did not answer.'; }
	}
	const phase = $derived(data.actions ? 'actions' : r?.kind === 'results' ? (r.page.total ? 'results' : 'empty') : (r?.kind ?? 'idle'));
	// the data is complete when the page renders (data-ready, also in the server's HTML); data-hydrated marks the
	// moment its controls respond
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="search" data-hydrated={ready ? '1' : null} data-busy={navigating.to ? 'true' : null} data-result={phase} data-page={r?.kind === 'results' ? r.page.page : null} data-search={data.submitted ? paramsOf(q).toString() : ''}>
	<PageHeader heading="Advanced Search" section="Advanced Search" caseName={data.version.titleName} subtitle="Cross-corpus search over document details and indexed text excerpts, with filters and action-item extraction" />
	<DegradedRows failed={data.failed} />
	<p class="disclosure" id="search-coverage" data-documents={cov.documents} data-with-excerpt={cov.withExcerpt} data-max-excerpt={cov.maxExcerpt} data-none={cov.none} data-pending={cov.pending} data-left-out={data.failed.length ? data.failed.length : null}>
		Search reads file names, refs, subjects, senders, To recipients and the indexed text excerpt of each document (at most {n(cov.maxExcerpt)} characters), not the full text. Cc recipients are searched only through Sender contains. {n(cov.withExcerpt)} of {n(cov.documents)} documents have an excerpt; {n(cov.none)} have no extracted text (scan · none) and {n(cov.pending)} are pending.{#if data.failed.length} Some documents are left out of the search and of these counts, because a document-row provider failed.{/if}
	</p>
	<form method="GET" class="card search-form" onsubmit={() => (sent = { ...f })} role="search" aria-label="Search the documents" data-sveltekit-keepfocus data-sveltekit-noscroll>
		<div class="row">
			<div><label class="fld" for="sq">Text</label><input class="in" id="sq" name="q" bind:value={f.q} maxlength={MAX_TEXT} /></div>
			<div><label class="fld" for="sb">Bundle</label><select class="in" id="sb" name="bundle" bind:value={f.bundle}><option value="">All</option>{#each data.options.bundles as b (b.value)}<option value={b.value}>{b.label}</option>{/each}</select></div>
			<div><label class="fld" for="st">Type</label><select class="in" id="st" name="type" bind:value={f.type}><option value="">All</option>{#each data.options.types as t (t)}<option value={t}>{t}</option>{/each}</select></div>
			<div><label class="fld" for="ss">Sender contains</label><input class="in" id="ss" name="sender" bind:value={f.sender} maxlength={MAX_TEXT} /></div>
		</div>
		<div class="row">
			<div><label class="fld" for="sf">From date</label><input class="in" id="sf" name="from" type="date" bind:value={f.from} /></div>
			<div><label class="fld" for="sto">To date</label><input class="in" id="sto" name="to" type="date" bind:value={f.to} /></div>
			<div><label class="fld" for="samin">Amount min</label><input class="in" id="samin" name="amin" bind:value={f.amin} /></div>
			<div><label class="fld" for="samax">Amount max</label><input class="in" id="samax" name="amax" bind:value={f.amax} /></div>
			<div><label class="fld" for="sst">Text status</label><select class="in" id="sst" name="status" bind:value={f.status}><option value="">Any</option>{#each data.options.statuses as s (s)}<option value={s}>{s}</option>{/each}</select></div>
		</div>
		<div class="toolbar">
			<button id="search-run" class="primary">Search</button>
			<button type="button" id="search-export" onclick={exportCsv}>Export CSV</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}
			<button type="button" id="search-actions" onclick={() => go({ actions: '1' })}>Extract action items</button>
		</div>
		{#if exportError}<p class="error" role="alert">{exportError}</p>{/if}
	</form>
	<div id="searchRes">
		{#if data.actions}
			<div class="card" id="action-items">
				{#if 'invalid' in data.actions}<p class="error" role="alert" data-result="invalid">{data.actions.invalid} Nothing was searched.</p>
				{:else}
					<h3>Action items ({data.actions.total})</h3>
					{#if !data.actions.total}<div class="empty">No action-item phrases found in the current result set.</div>
					{:else}<TableScroll label="Action items"><table class="tbl"><thead><tr><th>Date</th><th>Ref</th><th>Extracted action</th></tr></thead><tbody>{#each data.actions.shown as i, k (k)}<tr><td class="mono">{dateCell(i.date)}</td><td class="mono">{i.ref}</td><td>{i.t}</td></tr>{/each}</tbody></table></TableScroll>{/if}
				{/if}
			</div>
		{:else if r?.kind === 'invalid'}
			<p class="error" role="alert" id="search-invalid">{r.reason} Nothing was searched.</p>
		{:else if r?.kind === 'results'}
			{#if data.pageNotice}<p class="warning" id="search-page-notice">{data.pageNotice}</p>{/if}
			<div class="card pad0">
				<div class="count" id="search-count">Showing {r.page.from}–{r.page.to} of {n(r.page.total)} results</div>
				{#if !r.page.total}<p class="empty-result" id="search-empty" role="status">No documents match this search.</p>{:else}<p class="order-note" id="search-order">In register order; the export has the same order.</p>{/if}
				<TableScroll label="Search results"><table class="tbl" id="search-table">
					<thead><tr><th>Date</th><th>Ref</th><th>Title / subject</th><th>Type</th><th>Bundle</th><th class="num">Amount</th><th>Doc</th></tr></thead>
					<tbody>
						{#each r.page.slice as x (x.ref)}
							<tr data-ref={x.ref}>
								<td class="mono">{dateCell(x.date)}</td><td class="mono">{x.ref}</td>
								<td>{x.title}{#if x.excerpt}<div class="ex">{x.excerpt}</div>{/if}</td>
								<td><span class="badge">{x.type}</span></td><td><span class="badge">{x.bundle}</span></td><td class="num">{x.amount}</td>
								<td><a class="doc" href={docPath(vid, x.ref)}>{docLabel(x.file)}</a></td>
							</tr>
						{/each}
					</tbody>
				</table></TableScroll>
				<div class="pager" id="search-pager">
					<button type="button" disabled={r.page.page <= 1} onclick={() => go({ page: String(r.page.page - 1) })}>Prev</button>
					<span>Page {r.page.page} / {r.page.pages}</span>
					<button type="button" disabled={r.page.page >= r.page.pages} onclick={() => go({ page: String(r.page.page + 1) })}>Next</button>
					<span class="count">Showing {r.page.from}–{r.page.to} of {n(r.page.total)}</span>
				</div>
			</div>
		{/if}
	</div>
</main>

<style>
	#searchRes { margin-top: 1rem; }
</style>
