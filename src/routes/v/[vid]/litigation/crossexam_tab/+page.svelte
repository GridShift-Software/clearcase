<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import DeleteCell from '$lib/views/litigation/DeleteCell.svelte';
	import EntryState from '$lib/views/litigation/EntryState.svelte';
	import LeaveGuard from '$lib/views/litigation/LeaveGuard.svelte';
	import { CX_FIELDS, canAddCx, type CxValues } from '$lib/views/litigation/crossexam';
	import { EntryForm, type Answer } from '$lib/views/litigation/entry.svelte';
	import { ANALYSIS_NOTE, OWN_ROWS_NOTE } from '$lib/views/litigation/notes';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	// the entry and each row's Delete keep their own state (entry.svelte.ts); without JavaScript the answer re-fills it
	const entry = new EntryForm(CX_FIELDS, (v) => canAddCx(v as CxValues), untrack(() => form as Answer));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<!-- the data is complete when the server renders the page, so data-ready is set from the start (the pilot checks read
	it from the served HTML); data-hydrated marks when the page's controls work -->
<main id="main" tabindex="-1" data-ready="crossexam_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Cross-Exam Prep" section="Cross-Exam Prep" caseName={data.version.titleName} subtitle="Per-witness topics, what to put, and the documents to confront them with">
		<!-- S-crossexam_tab-3 (copied): v5 has a second Add in the page header; it submits the same form -->
		{#snippet actions()}<button type="submit" form="cx-add" class="primary" id="cx-add-header" disabled={entry.adding}>Add</button>{/snippet}
	</PageHeader>
	<div class="card">
		<form method="POST" action="?/add" id="cx-add" class="fields" aria-busy={entry.adding ? 'true' : null} use:enhance={entry.submit}>
			<input type="hidden" name="addId" value={data.addId} />
			<div><label for="cx_w">Witness</label><input id="cx_w" name="witness" bind:value={entry.values.witness} /></div>
			<div><label for="cx_t">Topic</label><input id="cx_t" name="topic" bind:value={entry.values.topic} /></div>
			<div class="wide"><label for="cx_put">What to put</label><input id="cx_put" name="put" bind:value={entry.values.put} /></div>
			<div><label for="cx_docs">Documents</label><input id="cx_docs" name="docs" bind:value={entry.values.docs} /></div>
			<div class="go"><button type="submit" id="cx-add-form" disabled={entry.adding}>Add</button></div>
		</form>
		<EntryState {entry} form="cx-add" errorId="cx-error" />
	</div>
	<div class="card pad0">
		<TableScroll label="Cross-examination topics"><table id="cx-table">
			<thead><tr><th>Witness</th><th>Topic</th><th>What to put</th><th>Documents</th><th></th></tr></thead>
			<tbody>
				{#each data.rows as r (r.key)}
					<tr data-kind={r.kind} data-row={r.key}>
						<td><b>{r.witness}</b>{#if r.note}<small class="warning-inline" data-note={r.kind}>{r.note}</small>{/if}</td>
						<td>{r.topic}</td>
						<td>{#if r.authored}<Narrative text={r.put} resultsVersion={vid} known={data.known} />{:else}{r.put}{/if}</td>
						<td>{r.docs}</td>
						<td>
							<DeleteCell {entry} form="cx-add" name={'rowId' in r.target ? 'rowId' : 'seedId'} value={r.del} />
						</td>
					</tr>
				{:else}
					<tr><td colspan="5"><div class="empty">No cross-exam topics yet.</div></td></tr>
				{/each}
			</tbody>
		</table></TableScroll>
	</div>
	{#if data.tip}<p class="tag">{data.tip}</p>{/if}
	<SourceNote text={ANALYSIS_NOTE} more={OWN_ROWS_NOTE} />
	<LeaveGuard unsaved={entry.unsaved} what="Your Cross-Exam entry is not saved." />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 10rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; }
	small { display: block; }
</style>
