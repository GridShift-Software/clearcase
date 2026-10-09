<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { docPath } from '$lib/local-case/model';
	import { cleanName, dateCell, docLabel, statusLabel } from '$lib/views/evidence/common';
	import { entryNote, filingsCsvRows, registerCsvRows, type RegisterEntry } from '$lib/views/evidence/filings';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	const files = $derived(new Map(data.files));
	// every action failure carries the typed values and a message; a failed save also names the row being edited
	const failed = $derived(form as { values?: Record<string, string>; message?: string; editing?: string } | null);
	const editing = $derived<RegisterEntry | null>(data.entries.find((e) => e.key === (failed?.editing ?? data.editing)) ?? null);
	// the form's values: what the user typed when a save failed, else the row being edited, else empty
	const typed = $derived<Record<string, string>>(failed?.values ?? editing?.fields ?? {});
	let transportError = $state<string | null>(null);
	const message = $derived(transportError ?? failed?.message ?? null);
	// A failure keeps the form as typed (no reset); a lost connection does not replace the page with an error page.
	const keep: SubmitFunction = () => async ({ result, update }) => {
		if (result.type === 'error') { transportError = `The register could not be saved: ${result.status ? 'the app reported an error' : 'the app did not answer'}. Your entry is kept below; try again.`; return; }
		transportError = null;
		await update({ reset: result.type === 'success' || result.type === 'redirect' });
	};
	const exportFilings = () => download('filings.csv', toCSV(filingsCsvRows(data.groups ?? [])));
	const exportRegister = () => download('filing-register.csv', toCSV(registerCsvRows(data.entries)));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'filings_tab' : null}>
	<PageHeader heading="Filings & Affidavits" section="Filings & Affidavits" caseName={data.version.titleName} subtitle={data.content.subtitle}>
		{#snippet actions()}<button type="button" id="export-filings" onclick={exportFilings} disabled={!data.groups}>Export CSV</button>{/snippet}
	</PageHeader>
	<p class="disclosure" id="classification-status" data-verification="unverified">Filing groups and document types are imported classifications; they have not been verified against the documents.</p>
	{#if data.content.orientation}
		<section class="card narr" aria-labelledby="orientation-heading"><h2 id="orientation-heading">Orientation</h2><Narrative text={data.content.orientation} resultsVersion={vid} known={[]} /></section>
	{/if}
	{#if !data.groups}<p class="warning">This results package has no filings dataset.</p>{/if}
	{#each data.groups ?? [] as g, gi (gi)}
		<section class="card group" aria-labelledby="group-{gi}" data-group={gi}>
			<h2 id="group-{gi}" class="chead">{g.key} <span class="tag">({g.items.length})</span></h2>
			{#if g.note}<p class="group-note">{g.note}</p>{/if}
			<table class="tbl">
				<thead><tr><th>Ref</th><th>Date</th><th>Filing / document</th><th>Type</th><th>Text</th><th>Doc</th></tr></thead>
				<tbody>
					{#each g.items as x, i (i)}
						<tr data-ref={x.ref}>
							<td class="mono">{x.ref}</td><td class="mono">{dateCell(x.date)}</td>
							<td><div>{cleanName(x.title)}</div>{#if x.note}<div class="ex">{x.note}</div>{/if}</td>
							<td><span class="badge" title="Imported classification, unverified">{x.doc_type}</span></td>
							<td>{statusLabel(x.text_status)}</td>
							<td>{#if files.get(x.ref) === undefined || files.get(x.ref) === null}<span class="cite-broken" title="not in this results version">{x.ref ? 'not found' : ''}</span>{:else}<a class="doc" href={docPath(vid, x.ref)}>{docLabel(files.get(x.ref))}</a>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/each}

	<section class="card register" aria-labelledby="register-heading">
		<h2 id="register-heading">Filing ↔ Replying-affidavit register</h2>
		<p class="register-intro">Log each filing and the responding/replying affidavit. Saved in this case's local work store; imported rows stay as imported and your changes are kept apart from them.</p>
		<form method="POST" action={editing ? '?/save' : '?/add'} class="register-form" use:enhance={keep} id="register-form" data-mode={editing ? 'edit' : 'add'}>
			{#if editing}<input type="hidden" name="key" value={editing.key} />{/if}
			<div class="row">
				<div><label class="fld" for="fl_filing">Filing</label><input class="in" id="fl_filing" name="filing" value={typed.filing ?? ''} /></div>
				<div><label class="fld" for="fl_fdate">Date</label><input class="in" id="fl_fdate" name="fdate" type="date" value={typed.fdate ?? ''} /></div>
				<div><label class="fld" for="fl_fparty">Party filing</label><input class="in" id="fl_fparty" name="fparty" value={typed.fparty ?? ''} /></div>
				<div><label class="fld" for="fl_response">Responding / replying affidavit</label><input class="in" id="fl_response" name="response" value={typed.response ?? ''} /></div>
				<div><label class="fld" for="fl_rdate">Response date</label><input class="in" id="fl_rdate" name="rdate" type="date" value={typed.rdate ?? ''} /></div>
				<div><label class="fld" for="fl_ref">Ref</label><input class="in" id="fl_ref" name="ref" value={typed.ref ?? ''} /></div>
				<div class="submit">{#if editing}<button id="register-save">Save</button> <a href="?" id="register-cancel">Cancel</a>{:else}<button id="register-add">Add</button>{/if}</div>
			</div>
			{#if message}<p class="error" role="alert" id="register-error">{message}</p>{/if}
		</form>
		<div class="toolbar"><button type="button" id="export-register" onclick={exportRegister}>Export register CSV</button></div>
		<table class="tbl" id="filing-register">
			<thead><tr><th>Filing</th><th>Filed</th><th>By</th><th>Replying / responding affidavit</th><th>Responded</th><th>Ref</th><th>Status</th><th></th></tr></thead>
			<tbody>
				{#if !data.entries.length}<tr><td colspan="8"><div class="empty">No filings logged yet.</div></td></tr>{/if}
				{#each data.entries as e (e.key)}
					<tr data-key={e.key} data-state={e.state}>
						<td><b>{e.fields.filing}</b>{#if entryNote(e)}<small class="entry-note">{entryNote(e)}</small>{/if}</td>
						<td class="mono">{dateCell(e.fields.fdate)}</td><td>{e.fields.fparty}</td>
						<td>{e.fields.response || '—'}</td><td class="mono">{dateCell(e.fields.rdate)}</td>
						<td>{#if e.fields.ref && files.get(e.fields.ref)}<CitationLink resultsVersion={vid} ref={e.fields.ref} label="{e.fields.ref} ↗" />{:else}{e.fields.ref}{/if}</td>
						<td>{#if e.fields.status}<span class="badge info">{e.fields.status}</span>{/if}</td>
						<td class="actions">
							<form method="GET"><input type="hidden" name="edit" value={e.key} /><button class="ghost">Edit</button></form>
							<form method="POST" action="?/delete" use:enhance={keep}><input type="hidden" name="key" value={e.key} /><button class="ghost">Delete</button></form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
</main>

<style>
	.group { margin-top: 1rem; }
	.chead { font-size: 1rem; margin: 0 0 .3rem; }
	.group-note, .register-intro { color: #555; margin: 0 0 .4rem; }
	.ex, .entry-note { display: block; color: #555; font-size: .85em; }
	.mono { font-family: ui-monospace, monospace; }
	.badge { display: inline-block; padding: 0 .4em; border-radius: 3px; background: #eef0f3; font-size: .85em; }
	.badge.info { background: #e3eefc; }
	.register { margin-top: 1rem; }
	.register-form .row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
	.fld { display: block; font-size: .85em; color: #555; }
	.toolbar { margin: .6rem 0; }
	.actions form { display: inline; }
	.disclosure { color: #6a4b00; }
	.empty { color: #666; padding: .4rem 0; }
</style>
