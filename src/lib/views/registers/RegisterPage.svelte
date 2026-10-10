<script lang="ts">
	// One register page (GRS-17): v5's form, Add, per-row Delete and the export, plus a per-row Edit that reuses the
	// form (acceptance beyond v5). Saves go through the page's actions; a failed save or delete shows its error and
	// keeps every typed value (a refused write, a busy store, a lost connection). Imported values are never shown here:
	// every cell is user-entered text, a chip, or a typed document ref linked only when it names a document.
	import { onMount, tick, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { now } from '$lib/components/clock';
	import { download } from '$lib/components/csv';
	import type { FieldDef } from './defs';
	import { deadlineCalendar, isSkipped, registerCsv, type Entry } from './logic';
	import type { ShownRow } from './page.server';

	type Data = {
		version: { id: string; titleName: string };
		register: { view: string; label: string; subtitle: string; empty: string; fields: readonly FieldDef[]; columns: readonly { label: string; num?: boolean }[]; export: { label: string; kind: 'csv' | 'ics'; name: string }; keepAfterAdd: readonly string[]; required: readonly string[] | null };
		rows: ShownRow[];
		exportRows: { rowId: string; values: Entry }[];
		icsProductId: string | null;
	};
	type Form = { values?: Entry; rowId?: string | null; message?: string } | null;
	let { data, form }: { data: Data; form: Form } = $props();
	const reg = $derived(data.register);
	const vid = $derived(data.version.id);

	/** An empty form: a select without a placeholder starts on its first option, as v5's does. */
	const blank = (): Entry => Object.fromEntries(reg.fields.map((f) => [f.k, f.type === 'select' && f.placeholder === undefined ? f.opts![0]! : '']));
	// without JavaScript a refused save re-renders the page with the action's values; keep them in the form
	let values = $state<Entry>(untrack(() => form?.values ?? blank()));
	let editing = $state<string | null>(untrack(() => form?.rowId ?? null));
	let error = $state<string | null>(untrack(() => form?.message ?? null));
	let busy = $state(false);
	let ready = $state(false);
	onMount(() => { ready = true; });

	// the request may or may not have reached the app, so the message does not claim either
	const lost = (what: string, status?: number) => `${what}: ${status ? `the app reported an error (${status})` : 'the app could not be reached'}. Your input is kept; check the list, then try again.`;

	const save: SubmitFunction = ({ cancel }) => {
		// v5 ignores an Add with nothing to save (every field empty, or a deadline without title or date), silently
		if (isSkipped(reg, values)) { cancel(); return; }
		busy = true;
		error = null;
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					// the form clears once the saved row is on the page
					await invalidateAll();
					const keep = editing ? {} : Object.fromEntries(reg.keepAfterAdd.map((k) => [k, values[k]!]));
					values = { ...blank(), ...keep };
					editing = null;
				} else if (result.type === 'failure') error = String(result.data?.message ?? 'The entry was not saved. Your input is kept; try again.');
				else if (result.type === 'redirect') await applyAction(result);
				else error = lost(editing ? 'The change may not have been saved' : 'The entry may not have been saved', result.status);
			} finally { busy = false; }
		};
	};
	const remove: SubmitFunction = ({ formData }) => {
		error = null;
		const id = formData.get('rowId');
		return async ({ result }) => {
			if (result.type === 'success') {
				if (editing && editing === id) cancelEdit();
				await invalidateAll();
			} else if (result.type === 'failure') error = String(result.data?.message ?? 'The deletion did not happen; try again.');
			else if (result.type === 'redirect') await applyAction(result);
			else error = lost('The deletion may not have happened', result.status);
		};
	};

	async function edit(r: ShownRow) {
		editing = r.rowId;
		values = { ...blank(), ...r.values };
		error = null;
		await tick();
		document.getElementById(`in-${reg.fields[0]!.k}`)?.focus();
	}
	function cancelEdit() {
		editing = null;
		values = blank();
		error = null;
	}
	function exportNow() {
		if (reg.export.kind === 'ics') download(reg.export.name, deadlineCalendar(data.exportRows, { now: now(), productId: data.icsProductId }), 'text/calendar;charset=utf-8');
		else download(reg.export.name, registerCsv(reg, data.exportRows));
	}
</script>

<!-- the rows are complete when the page renders, so data-ready is set on the server too; data-hydrated marks that the
     form is interactive (tests type and click only after it) -->
<main id="main" tabindex="-1" data-ready={reg.view} data-hydrated={ready ? '' : undefined}>
	<PageHeader heading={reg.label} section={reg.label} caseName={data.version.titleName} subtitle={reg.subtitle}>
		{#snippet actions()}
			<button type="button" id="register-export" onclick={exportNow}>{reg.export.label}</button>
			<button type="submit" form="register-form" id="register-save" disabled={busy}>{editing ? 'Save' : 'Add'}</button>
			{#if editing}<button type="button" id="register-cancel" onclick={cancelEdit}>Cancel</button>{/if}
		{/snippet}
	</PageHeader>

	<form id="register-form" class="entry" method="POST" action="?/save" use:enhance={save} data-editing={editing ?? undefined}>
		{#if editing}<input type="hidden" name="rowId" value={editing} />{/if}
		{#each reg.fields as f (f.k)}
			<div class="field" class:wide={f.type === 'textarea' || f.k === 'note'}>
				<label for="in-{f.k}">{f.label}</label>
				{#if f.type === 'select'}
					<select id="in-{f.k}" name={f.k} bind:value={values[f.k]}>
						{#if f.placeholder !== undefined}<option value="">{f.placeholder}</option>{/if}
						{#each f.opts ?? [] as o (o)}<option value={o}>{o}</option>{/each}
					</select>
				{:else if f.type === 'textarea'}
					<textarea id="in-{f.k}" name={f.k} bind:value={values[f.k]}></textarea>
				{:else}
					<input id="in-{f.k}" name={f.k} type={f.type} bind:value={values[f.k]} />
				{/if}
			</div>
		{/each}
	</form>
	{#if error}<p class="error" role="alert" id="register-error">{error}</p>{/if}

	<div class="table-wrap">
		<table id="register-table" data-rows={data.rows.length}>
			<thead><tr>{#each reg.columns as c (c.label)}<th class:end={c.num}>{c.label}</th>{/each}<th aria-label="Entry actions"></th></tr></thead>
			<tbody>
				{#if !data.rows.length}<tr><td colspan={reg.columns.length + 1}>{reg.empty}</td></tr>{/if}
				{#each data.rows as r (r.rowId)}
					<tr data-row-id={r.rowId} class:editing={editing === r.rowId}>
						{#each r.cells as c, i (i)}
							<td class:end={reg.columns[i]?.num}>
								{#if c.kind === 'chip'}<span class="chip tone-{c.tone}">{c.text}</span>
								{:else if c.kind === 'ref'}<CitationLink resultsVersion={vid} ref={c.target ?? c.text} label={c.text} exists={c.target !== null} />
								{:else}{c.text}{/if}
							</td>
						{/each}
						<td class="row-actions">
							<button type="button" data-edit onclick={() => edit(r)}>Edit</button>
							<form method="POST" action="?/delete" use:enhance={remove}><input type="hidden" name="rowId" value={r.rowId} /><button data-delete>Delete</button></form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</main>

<style>
	.entry { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0; align-items: flex-end; }
	.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 10rem; }
	.field.wide { flex: 2; min-width: 16rem; }
	.field textarea { min-height: 4rem; }
	.table-wrap { overflow-x: auto; }
	td.end, th.end { text-align: end; }
	tr.editing { outline: 2px solid currentColor; }
	.row-actions { white-space: nowrap; }
	.row-actions form { display: inline; }
	.chip { display: inline-block; padding: 0 0.4rem; border-radius: 0.6rem; border: 1px solid currentColor; font-size: 0.9em; }
	.tone-muted { opacity: 0.75; }
	.tone-danger { color: #a00; }
	.tone-warning { color: #8a5a00; }
	.tone-success { color: #146c2e; }
	.tone-info { color: #1d4f91; }
</style>
