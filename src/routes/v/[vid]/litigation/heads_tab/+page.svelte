<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import DeleteCell from '$lib/views/litigation/DeleteCell.svelte';
	import EntryState from '$lib/views/litigation/EntryState.svelte';
	import LeaveGuard from '$lib/views/litigation/LeaveGuard.svelte';
	import { EntryForm, type Answer } from '$lib/views/litigation/entry.svelte';
	import { HEADS_FIELDS, canAddHead, headsText, type HeadsValues } from '$lib/views/litigation/heads';
	import { ANALYSIS_NOTE, OWN_ROWS_NOTE } from '$lib/views/litigation/notes';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	// the entry and each row's Delete keep their own state (entry.svelte.ts); without JavaScript the answer re-fills it
	const entry = new EntryForm(HEADS_FIELDS, (v) => canAddHead(v as HeadsValues), untrack(() => form as Answer));
	const exportText = () => download(data.exportName.name, headsText(data.rows, data.caption), 'text/plain;charset=utf-8');
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<!-- the data is complete when the server renders the page, so data-ready is set from the start (the pilot checks read
	it from the served HTML); data-hydrated marks when the page's controls work -->
<main id="main" tabindex="-1" data-ready="heads_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Heads of Argument" section="Heads of Argument" caseName={data.version.titleName} subtitle="Build the skeleton — each submission tied to authority and evidence">
		{#snippet actions()}<button type="button" id="heads-export" onclick={exportText}>Export</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}{/snippet}
	</PageHeader>
	<div class="card">
		<form method="POST" action="?/add" id="hd-add" class="fields" aria-busy={entry.adding ? 'true' : null} use:enhance={entry.submit}>
			<input type="hidden" name="addId" value={data.addId} />
			<div><label for="hd_head">Heading</label><input id="hd_head" name="head" bind:value={entry.values.head} /></div>
			<div class="wide"><label for="hd_sub">Submission</label><input id="hd_sub" name="sub" bind:value={entry.values.sub} /></div>
			<div><label for="hd_auth">Authority</label><input id="hd_auth" name="auth" bind:value={entry.values.auth} /></div>
			<div><label for="hd_ref">Evidence ref(s)</label><input id="hd_ref" name="ref" placeholder="e.g. OD-1, SD-2" bind:value={entry.values.ref} /></div>
			<div class="go"><button type="submit" class="primary" id="hd-add-button" disabled={entry.adding}>Add</button></div>
		</form>
		<EntryState {entry} form="hd-add" errorId="hd-error" />
	</div>
	<div class="card pad0">
		<table id="heads-table">
			<thead><tr><th>#</th><th>Heading</th><th>Submission</th><th>Authority</th><th>Evidence</th><th></th></tr></thead>
			<tbody>
				{#each data.rows as r, i (r.rowId)}
					<tr data-row={r.rowId}>
						<td class="mono">{i + 1}</td>
						<td><b>{r.head}</b></td>
						<td>{r.sub}</td>
						<td>{r.auth}</td>
						<td>{#each r.evidence as t, j (j)}{j ? ' ' : ''}{#if t.ref}<CitationLink resultsVersion={vid} ref={t.text} />{:else}<span>{t.text}</span>{/if}{/each}</td>
						<td>
							<DeleteCell {entry} form="hd-add" name="rowId" value={r.del} />
						</td>
					</tr>
				{:else}
					<tr><td colspan="6"><div class="empty">No submissions yet — build your skeleton argument here.</div></td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<SourceNote text={ANALYSIS_NOTE} more={OWN_ROWS_NOTE} />
	<LeaveGuard unsaved={entry.unsaved} what="Your Heads of Argument entry is not saved." />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 9rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; overflow-x: auto; }
	.empty { color: #555; padding: 1rem; text-align: center; }
</style>
