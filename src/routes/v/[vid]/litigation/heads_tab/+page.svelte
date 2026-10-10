<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { HEADS_FILE, headsText } from '$lib/views/litigation/heads';
	import { REGISTER_NOTE } from '$lib/views/litigation/notes';
	import { keepInput } from '$lib/views/litigation/submit';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	let lost = $state<string | null>(null);
	const message = $derived(lost ?? (form && 'message' in form ? form.message : null));
	const values = $derived(form && 'values' in form ? (form.values as Record<string, string>) : null);
	const submit = keepInput((m) => (lost = m), () => (lost = null));
	const exportText = () => download(HEADS_FILE, headsText(data.rows, data.caption), 'text/plain;charset=utf-8');
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'heads_tab' : null}>
	<PageHeader heading="Heads of Argument" section="Heads of Argument" caseName={data.version.titleName} subtitle="Build the skeleton — each submission tied to authority and evidence">
		{#snippet actions()}<button type="button" id="heads-export" onclick={exportText}>Export</button>{/snippet}
	</PageHeader>
	<div class="card">
		<form method="POST" action="?/add" id="hd-add" class="fields" use:enhance={submit}>
			<div><label for="hd_head">Heading</label><input id="hd_head" name="head" value={values?.head ?? ''} /></div>
			<div class="wide"><label for="hd_sub">Submission</label><input id="hd_sub" name="sub" value={values?.sub ?? ''} /></div>
			<div><label for="hd_auth">Authority</label><input id="hd_auth" name="auth" value={values?.auth ?? ''} /></div>
			<div><label for="hd_ref">Evidence ref(s)</label><input id="hd_ref" name="ref" placeholder="e.g. OD-1, SD-2" value={values?.ref ?? ''} /></div>
			<div class="go"><button type="submit" class="primary" id="hd-add-button">Add</button></div>
		</form>
		{#if message}<p class="error" role="alert" id="hd-error">{message}</p>{/if}
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
							<form method="POST" action="?/delete" use:enhance={submit}>
								<input type="hidden" name="rowId" value={r.rowId} />
								<button type="submit" class="ghost">Delete</button>
							</form>
						</td>
					</tr>
				{:else}
					<tr><td colspan="6"><div class="empty">No submissions yet — build your skeleton argument here.</div></td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<SourceNote text={REGISTER_NOTE} />
</main>

<style>
	.fields { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
	.fields > div { display: flex; flex-direction: column; flex: 1 1 9rem; }
	.fields > .wide { flex: 2 1 16rem; }
	.fields > .go { flex: 0 0 auto; }
	.pad0 { padding: 0; overflow-x: auto; }
	.empty { color: #555; padding: 1rem; text-align: center; }
	td form { margin: 0; }
</style>
