<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import EntryState from '$lib/views/litigation/EntryState.svelte';
	import LeaveGuard from '$lib/views/litigation/LeaveGuard.svelte';
	import { AUTH_FIELDS, authoritiesCsv, canAddAuthority, type AuthValues } from '$lib/views/litigation/authorities';
	import { EntryForm, type Answer } from '$lib/views/litigation/entry.svelte';
	import { ANALYSIS_NOTE, HOSTED_ROWS_NOTE, OWN_ROWS_NOTE } from '$lib/views/litigation/notes';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import { writeAccess } from '$lib/components/write-access';
	let { data, form } = $props();
	const access = writeAccess();
	const vid = $derived(data.version.id);
	const entry = new EntryForm(AUTH_FIELDS, (v) => canAddAuthority(v as AuthValues), untrack(() => form as Answer));
	const exportCsv = () => download(data.exportName.name, authoritiesCsv(data.imported, data.user));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="authorities_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Authorities" section="Authorities" caseName={data.version.titleName} subtitle="The statutory and case-law framework — tie each proposition to its source">
		{#snippet actions()}<button type="button" id="auth-export" onclick={exportCsv}>Export CSV</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}{/snippet}
	</PageHeader>
	{#if access.canWrite}
	<div class="card">
		<form method="POST" action="?/add" id="au-add" class="fields" aria-busy={entry.adding ? 'true' : null} use:enhance={entry.submit}>
			<input type="hidden" name="addId" value={data.addId} />
			<div><label for="au_topic">Topic</label><input id="au_topic" name="topic" bind:value={entry.values.topic} /></div>
			<div class="wide"><label for="au_auth">Authority</label><input id="au_auth" name="authority" bind:value={entry.values.authority} /></div>
			<div class="wide"><label for="au_prop">Proposition</label><input id="au_prop" name="proposition" bind:value={entry.values.proposition} /></div>
			<div class="go"><button type="submit" class="primary" id="au-add-button" disabled={entry.adding}>Add</button></div>
		</form>
		<EntryState {entry} form="au-add" errorId="au-error" />
	</div>
	{/if}
	<div class="card pad0">
		<!-- v5 has no edit or delete for authorities (S-authorities_tab-1, copied) -->
		<TableScroll label="Authorities"><table id="auth-table">
			<thead><tr><th>Topic</th><th>Authority</th><th>Proposition</th></tr></thead>
			<tbody>
				{#each data.imported as r, i (i)}
					<tr data-source="imported"><td><b>{r.topic}</b></td><td>{r.authority}</td><td class="ex"><Narrative text={r.proposition} resultsVersion={vid} known={data.known} /></td></tr>
				{/each}
				{#each data.user as r (r.rowId)}
					<tr data-source="user" data-row={r.rowId}><td><b>{r.topic}</b></td><td>{r.authority}</td><td class="ex">{r.proposition}</td></tr>
				{/each}
				{#if !data.imported.length && !data.user.length}
					<tr><td colspan="3"><div class="empty">{data.present ? 'No authorities in this results package yet.' : 'This results package has no authorities.'}{access.canWrite ? ' Add your own above.' : ''}</div></td></tr>
				{/if}
			</tbody>
		</table></TableScroll>
	</div>
	<p class="tag">Framework provided as a working aide — confirm citations and current status before relying on them.</p>
	<SourceNote text={ANALYSIS_NOTE} more={access.hosted ? HOSTED_ROWS_NOTE : OWN_ROWS_NOTE} />
	<LeaveGuard unsaved={entry.unsaved} what="Your Authorities entry is not saved." />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 9rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; }
</style>
