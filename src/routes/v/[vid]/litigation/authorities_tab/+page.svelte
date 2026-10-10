<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { AUTH_FILE, authoritiesCsv } from '$lib/views/litigation/authorities';
	import { REGISTER_NOTE } from '$lib/views/litigation/notes';
	import { keepInput } from '$lib/views/litigation/submit';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	let lost = $state<string | null>(null);
	const message = $derived(lost ?? (form && 'message' in form ? form.message : null));
	const values = $derived(form && 'values' in form ? (form.values as Record<string, string>) : null);
	const submit = keepInput((m) => (lost = m), () => (lost = null));
	const exportCsv = () => download(AUTH_FILE, authoritiesCsv(data.imported, data.user));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'authorities_tab' : null}>
	<PageHeader heading="Authorities" section="Authorities" caseName={data.version.titleName} subtitle="The statutory and case-law framework — tie each proposition to its source">
		{#snippet actions()}<button type="button" id="auth-export" onclick={exportCsv}>Export CSV</button>{/snippet}
	</PageHeader>
	<div class="card">
		<form method="POST" action="?/add" id="au-add" class="fields" use:enhance={submit}>
			<div><label for="au_topic">Topic</label><input id="au_topic" name="topic" value={values?.topic ?? ''} /></div>
			<div class="wide"><label for="au_auth">Authority</label><input id="au_auth" name="authority" value={values?.authority ?? ''} /></div>
			<div class="wide"><label for="au_prop">Proposition</label><input id="au_prop" name="proposition" value={values?.proposition ?? ''} /></div>
			<div class="go"><button type="submit" class="primary" id="au-add-button">Add</button></div>
		</form>
		{#if message}<p class="error" role="alert" id="au-error">{message}</p>{/if}
	</div>
	<div class="card pad0">
		<!-- v5 has no edit or delete for authorities (S-authorities_tab-1, copied) -->
		<table id="auth-table">
			<thead><tr><th>Topic</th><th>Authority</th><th>Proposition</th></tr></thead>
			<tbody>
				{#each data.imported as r, i (i)}
					<tr data-source="imported"><td><b>{r.topic}</b></td><td>{r.authority}</td><td class="ex"><Narrative text={r.proposition} resultsVersion={vid} known={data.known} /></td></tr>
				{/each}
				{#each data.user as r (r.rowId)}
					<tr data-source="user" data-row={r.rowId}><td><b>{r.topic}</b></td><td>{r.authority}</td><td class="ex">{r.proposition}</td></tr>
				{/each}
				{#if !data.imported.length && !data.user.length}
					<tr><td colspan="3"><div class="empty">{data.present ? 'No authorities in this results package yet.' : 'This results package has no authorities.'} Add your own above.</div></td></tr>
				{/if}
			</tbody>
		</table>
	</div>
	<p class="tag">Framework provided as a working aide — confirm citations and current status before relying on them.</p>
	<SourceNote text={REGISTER_NOTE} />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 9rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; overflow-x: auto; }
	.empty { color: #555; padding: 1rem; text-align: center; }
	.tag { font-size: 0.9rem; color: #444; }
</style>
