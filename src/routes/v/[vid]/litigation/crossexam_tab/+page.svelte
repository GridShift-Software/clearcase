<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { REGISTER_NOTE } from '$lib/views/litigation/notes';
	import { keepInput } from '$lib/views/litigation/submit';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	let lost = $state<string | null>(null);
	const message = $derived(lost ?? (form && 'message' in form ? form.message : null));
	const values = $derived(form && 'values' in form ? (form.values as Record<string, string>) : null);
	const submit = keepInput((m) => (lost = m), () => (lost = null));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'crossexam_tab' : null}>
	<PageHeader heading="Cross-Exam Prep" section="Cross-Exam Prep" caseName={data.version.titleName} subtitle="Per-witness topics, what to put, and the documents to confront them with">
		<!-- S-crossexam_tab-3 (copied): v5 has a second Add in the page header; it submits the same form -->
		{#snippet actions()}<button type="submit" form="cx-add" class="primary" id="cx-add-header">Add</button>{/snippet}
	</PageHeader>
	<div class="card">
		<form method="POST" action="?/add" id="cx-add" class="fields" use:enhance={submit}>
			<div><label for="cx_w">Witness</label><input id="cx_w" name="witness" value={values?.witness ?? ''} /></div>
			<div><label for="cx_t">Topic</label><input id="cx_t" name="topic" value={values?.topic ?? ''} /></div>
			<div class="wide"><label for="cx_put">What to put</label><input id="cx_put" name="put" value={values?.put ?? ''} /></div>
			<div><label for="cx_docs">Documents</label><input id="cx_docs" name="docs" value={values?.docs ?? ''} /></div>
			<div class="go"><button type="submit" id="cx-add-form">Add</button></div>
		</form>
		{#if message}<p class="error" role="alert" id="cx-error">{message}</p>{/if}
	</div>
	<div class="card pad0">
		<table id="cx-table">
			<thead><tr><th>Witness</th><th>Topic</th><th>What to put</th><th>Documents</th><th></th></tr></thead>
			<tbody>
				{#each data.rows as r (r.key)}
					<tr data-kind={r.kind} data-row={r.key}>
						<td><b>{r.witness}</b>{#if r.note}<small class="warning-inline" data-note={r.kind}>{r.note}</small>{/if}</td>
						<td>{r.topic}</td>
						<td>{#if r.authored}<Narrative text={r.put} resultsVersion={vid} known={data.known} />{:else}{r.put}{/if}</td>
						<td>{r.docs}</td>
						<td>
							<form method="POST" action="?/delete" use:enhance={submit}>
								{#if 'rowId' in r.target}<input type="hidden" name="rowId" value={r.target.rowId} />{:else}<input type="hidden" name="seedId" value={r.target.seedId} />{/if}
								<button type="submit" class="ghost">Delete</button>
							</form>
						</td>
					</tr>
				{:else}
					<tr><td colspan="5"><div class="empty">No cross-exam topics yet.</div></td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if data.tip}<p class="tag">{data.tip}</p>{/if}
	<SourceNote text={REGISTER_NOTE} />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 10rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; overflow-x: auto; }
	small { display: block; }
	.empty { color: #555; padding: 1rem; text-align: center; }
	.tag { font-size: 0.9rem; color: #444; }
	td form { margin: 0; }
</style>
