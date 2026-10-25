<script lang="ts">
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import { money } from '$lib/components/format';
	import { excerptPreview, statusLabel } from '$lib/local-case/chronology';
	import { displayFilename, revealInvisible } from '$lib/views/hosted/display';
	import type { ChronologyData } from '$lib/views/hosted/model';
	let { data }: { data: { caseId: string; label: string; caseHref: string; notesHref: string; chronology: ChronologyData } } = $props();
	const c = $derived(data.chronology);
	const n = (x: number) => x.toLocaleString('en');
</script>

<main id="main" tabindex="-1" data-view="chronology" data-results-version={c.resultsVersion}>
	<p><a href={data.caseHref}>{displayFilename(data.label)}</a> › Chronology</p>
	<h1>Chronology</h1>
	<p>{n(c.total)} items · sorted by date</p>
	<DegradedRows failed={c.failed} />
	<form class="filters" role="search" aria-label="Filter the chronology" method="GET">
		<label>Text, ref or filename<br /><input id="f-q" name="q" value={c.query.q} /></label>
		<label>Bundle<br /><select id="f-bundle" name="bundle" value={c.query.bundle}><option value="">All bundles</option>{#each c.options.bundles as b (b)}<option value={b}>{revealInvisible(b)}</option>{/each}</select></label>
		<label>Type<br /><select id="f-type" name="type" value={c.query.type}><option value="">All types</option>{#each c.options.types as t (t)}<option value={t}>{revealInvisible(t)}</option>{/each}</select></label>
		<label>Text status<br /><select id="f-status" name="status" value={c.query.status}><option value="">Any text status</option>{#each c.options.statuses as s (s)}<option value={s}>{revealInvisible(s)}</option>{/each}</select></label>
		<button type="submit" id="f-apply">Search</button>
		<span id="row-count" role="status" aria-live="polite" data-count={c.items.length}>{n(c.items.length)} of {n(c.total)} documents</span>
	</form>
	{#if c.originals === 'unavailable'}<p role="status" data-originals-state="unavailable">Originals are unavailable right now, so rows do not link to them. Try again shortly.</p>{/if}
	<table aria-label="Chronology">
		<thead><tr><th scope="col">Date</th><th scope="col">Ref</th><th scope="col">Title / subject</th><th scope="col">Type</th><th scope="col">Bundle</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Original</th></tr></thead>
		<tbody>
			{#each c.items as r (r.ref)}
				<tr data-ref={r.ref}>
					<td>{r.date || 'undated'}</td>
					<td><span class="cite" data-citation={r.ref}>{revealInvisible(r.ref)}</span>{#if r.parentRef}<small> in {revealInvisible(r.parentRef)}</small>{/if}</td>
					<td>{revealInvisible(r.title)}{#if r.sender}<small> — {revealInvisible(r.sender)}</small>{/if}{#if r.excerpt}<br /><small>{revealInvisible(excerptPreview(r.excerpt))}</small>{/if}</td>
					<td>{revealInvisible(r.docType)}</td>
					<td>{revealInvisible(r.bundle)}</td>
					<td>{money(r.amount)}</td>
					<td>{statusLabel(r.textStatus)}</td>
					<td>{#if r.originalHref}<a data-action="open-original" data-asset-id={r.originalAssetId} href={r.originalHref}>open</a>{:else}<span data-file={r.file}>{r.file === 'present' ? 'not linked' : r.file}</span>{/if}</td>
				</tr>
			{:else}
				<tr><td colspan="8">No documents match these filters.</td></tr>
			{/each}
		</tbody>
	</table>
	<p><a data-action="open-notes" href={data.notesHref}>Your notes</a></p>
</main>
