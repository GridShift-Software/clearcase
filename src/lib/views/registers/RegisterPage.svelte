<script lang="ts">
	// One register page (GRS-17): v5's form, Add, per-row Delete and the export, plus a per-row Edit that reuses the
	// form (acceptance beyond v5). Imported values are never shown here: every cell is user-entered text, a chip, or a
	// typed document ref linked only when it names a document.
	//
	// Unsaved input is never lost and never shown as saved (CC-07 r2). While a save is in flight the form, Cancel and
	// every row's Edit and Delete are inert and a status says so; its result applies to what was submitted. A refused
	// save keeps its input with its error and a Retry until that save succeeds, is retried or is discarded on purpose
	// (Discard, or a confirmed Edit, Cancel, Delete of the edited row or navigation). Delete errors are kept apart and
	// never clear a save failure, nor the reverse. Without JavaScript a refused save re-renders with the action's
	// values, row id and version, and every row's Edit and Delete stay off until it is retried or discarded; a success
	// never re-enters edit mode.
	import { onMount, tick, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { now } from '$lib/components/clock';
	import { download } from '$lib/components/csv';
	import type { FieldDef } from './defs';
	import { deadlineCalendar, registerCsv, unsavable, type Entry } from './logic';
	import type { ShownRow } from './page.server';

	type Data = {
		version: { id: string; titleName: string };
		register: { view: string; label: string; subtitle: string; empty: string; fields: readonly FieldDef[]; columns: readonly { label: string; num?: boolean }[]; export: { label: string; kind: 'csv' | 'ics'; name: string }; keepAfterAdd: readonly string[]; required: readonly string[] | null };
		rows: ShownRow[];
		exportRows: { rowId: string; values: Entry }[];
		exportName: { name: string; note: string | null };
		icsProductId: string | null;
	};
	type Form = { op?: 'save' | 'delete'; values?: Entry; rowId?: string | null; version?: string | null; message?: string; retry?: boolean } | null;
	let { data, form }: { data: Data; form: Form } = $props();
	const reg = $derived(data.register);
	const vid = $derived(data.version.id);

	/** An empty form: a select without a placeholder starts on its first option, as v5's does. */
	const blank = (): Entry => Object.fromEntries(reg.fields.map((f) => [f.k, f.type === 'select' && f.placeholder === undefined ? f.opts![0]! : '']));
	// without JavaScript a refused save or delete re-renders the page with the action's result
	const saved = untrack(() => (form?.op === 'save' && form.message ? form : null));
	let values = $state<Entry>(untrack(() => ({ ...blank(), ...saved?.values })));
	let editing = $state<string | null>(saved?.rowId ?? null);
	let version = $state<string | null>(saved?.version ?? null);
	/** the form as last loaded or saved: input that differs from it is unsaved */
	let base = $state<Entry>(untrack(() => blank()));
	type Draft = { rowId: string | null; version: string | null; values: Entry };
	/** a refused save; `stale` after a 409, `draft` when the form no longer held what was submitted (restorable) */
	let saveError = $state<{ message: string; retry: boolean; stale?: boolean; draft?: Draft } | null>(saved ? { message: saved.message!, retry: saved.retry === true } : null);
	let deleteError = $state<{ rowId: string | null; message: string } | null>(untrack(() => (form?.op === 'delete' && form.message ? { rowId: form.rowId ?? null, message: form.message } : null)));
	/** a save in flight */
	let busy = $state(false);
	/** the row whose delete is in flight */
	let deleting = $state<string | null>(null);
	/** the form is inert while a save, or the delete of the entry being edited, is in flight: nothing can be typed and lost */
	const locked = $derived(busy || (editing !== null && deleting === editing));
	/** fields where the other tab's change and the typed change collided in the last rebase */
	let rebaseNote = $state<string | null>(null);
	/** an action waiting for the user to confirm that the unsaved input may be discarded */
	let ask = $state<{ what: string; go: () => void; leave?: boolean } | null>(null);
	let ready = $state(false);
	onMount(() => { ready = true; });

	const dirty = $derived(reg.fields.some((f) => (values[f.k] ?? '') !== (base[f.k] ?? '')));
	const unsaved = $derived(dirty || saveError !== null);
	const question = () => `${saveError ? 'The entry in the form was not saved.' : 'The entry in the form has changes that are not saved.'} Discard it?`;
	/** Run `go` now, or once the user confirms that the unsaved input in the form may be discarded. */
	function guard(go: () => void) {
		if (busy) return;
		if (unsaved) ask = { what: question(), go };
		else go();
	}
	function reset(keep: Entry = {}) {
		values = { ...blank(), ...keep };
		base = { ...values };
		editing = null;
		version = null;
		saveError = null;
		rebaseNote = null;
	}

	// the request may or may not have reached the app, so the message does not claim either; a 413 is refused before
	// the action runs, so it does
	const lost = (what: string, status?: number) =>
		status === 413 ? `${what} was not saved: it is too large to send. Nothing was changed and your input is kept; shorten it, then try again.`
		: `${what} may not have been saved: ${status ? `the app reported an error (${status})` : 'the app could not be reached'}. Your input is kept; check the list, then try again.`;

	const save: SubmitFunction = ({ cancel }) => {
		// v5 ignores an Add with nothing typed, silently; an emptied Edit or a deadline without title or date says why
		const why = unsavable(reg, values, editing !== null);
		if (why !== null) { cancel(); if (why) saveError = { message: why, retry: false }; return; }
		// the result applies to what was submitted; the form is inert until it arrives, and a discard question asked
		// before the save no longer applies
		const sent: Draft = { rowId: editing, version, values: { ...values } };
		busy = true;
		saveError = null;
		rebaseNote = null;
		ask = null;
		return async ({ result }) => {
			try {
				// the result changes the form only while the form still holds what was submitted
				const holds = editing === sent.rowId && reg.fields.every((f) => (values[f.k] ?? '') === (sent.values[f.k] ?? ''));
				if (result.type === 'success') {
					await invalidateAll();
					if (holds) reset(sent.rowId ? {} : Object.fromEntries(reg.keepAfterAdd.map((k) => [k, sent.values[k]!])));
				} else if (result.type === 'redirect') await applyAction(result);
				else {
					const failed = result.type === 'failure'
						? { message: String(result.data?.message ?? 'The entry was not saved. Your input is kept; try again.'), retry: result.data?.retry === true, stale: result.status === 409 }
						: { message: lost(sent.rowId ? 'The change' : 'The entry', result.status), retry: result.status !== 413 };
					saveError = holds ? failed : { ...failed, retry: false, draft: sent };
					// deleted or changed elsewhere: the list shows the entry as it is now, the form keeps the input
					if (result.status === 404 || result.status === 409) await invalidateAll();
				}
			} finally { busy = false; }
		};
	};
	const remove: SubmitFunction = ({ formData, cancel, formElement }) => {
		const id = String(formData.get('rowId'));
		// deleting the entry being edited discards the form's input: ask first when it is unsaved (an emptied form, which
		// the emptied-edit message sends to Delete, holds nothing to lose)
		const typed = reg.fields.some((f) => values[f.k] && !(f.type === 'select' && f.placeholder === undefined));
		// once confirmed the form leaves the entry at once, so a failed delete cannot show the typed text as stored
		if (id === editing && unsaved && typed) { cancel(); ask = { what: question(), go: () => { reset(); formElement.requestSubmit(); } }; return; }
		deleting = id;
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					if (deleteError && (deleteError.rowId === id || deleteError.rowId === null)) deleteError = null;
					if (editing === id) reset();
					await invalidateAll();
				} else if (result.type === 'failure') deleteError = { rowId: id, message: String(result.data?.message ?? 'The deletion did not happen; try again.') };
				else if (result.type === 'redirect') await applyAction(result);
				else deleteError = { rowId: id, message: lost('The deletion', result.status).replace('may not have been saved', 'may not have happened').replace('was not saved', 'did not happen') };
			} finally { deleting = null; }
		};
	};

	function edit(r: ShownRow) {
		guard(async () => {
			editing = r.rowId;
			version = r.version;
			values = { ...blank(), ...r.values };
			base = { ...values };
			saveError = null;
			rebaseNote = null;
			await tick();
			firstField()?.focus();
		});
	}
	const cancelEdit = () => guard(() => reset());
	function discard(e: MouseEvent) {
		e.preventDefault();
		reset();
	}
	const firstField = () => document.getElementById(`in-${reg.fields[0]!.k}`);
	/** what had focus when the question opened, so Keep it can give focus back */
	let opener: HTMLElement | null = null;
	// the question takes focus (on Keep it, the safe answer); the removed button would otherwise drop it to <body>
	$effect(() => {
		if (!ask) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || active === document.body) opener = null;
		else if (!active.closest('#register-ask')) opener = active;
		void tick().then(() => document.getElementById('register-ask-keep')?.focus());
	});
	// A cancelled Back is undone with a popstate, after which the layout moves focus to the heading (BA-14): the open
	// question takes it back
	onMount(() => {
		const h = () => setTimeout(() => { if (ask) document.getElementById('register-ask-keep')?.focus(); });
		addEventListener('popstate', h);
		return () => removeEventListener('popstate', h);
	});
	/** Focus the first of `targets` that can take it: an element that is gone or disabled falls through to the next. */
	async function focusFirst(...targets: (HTMLElement | null | undefined)[]) {
		await tick();
		for (const t of [...targets, document.getElementById('main')]) {
			if (!t?.isConnected) continue;
			t.focus();
			if (document.activeElement === t) return;
		}
	}
	function answer(yes: boolean) {
		const a = ask;
		// while a save is in flight its result decides the form: only leaving the page may be answered
		if (!a || (busy && !a.leave)) return;
		ask = null;
		if (yes) { saveError = null; base = { ...values }; a.go(); void focusFirst(firstField()); }
		else void focusFirst(opener, firstField());
	}
	/** Put a failed draft back in the form, so Retry resubmits exactly it. */
	function restore(d: Draft) {
		values = { ...blank(), ...d.values };
		editing = d.rowId;
		version = d.version;
		saveError = { message: saveError!.message, retry: true };
	}
	/** After a 409, a 3-way merge of the entry's current stored values into the form: a field the user left as loaded
	 *  takes the current value (the other tab's change is kept), a field the user changed keeps the typed value. Where
	 *  both changed the same field to different values the typed value wins and the note names the field. The current
	 *  values become the base, so the next Save replaces the current entry with the merged form. */
	function rebase(r: ShownRow) {
		const current = { ...blank(), ...r.values };
		const clash: string[] = [];
		const merged = { ...values };
		for (const f of reg.fields) {
			const mine = values[f.k] ?? '', loaded = base[f.k] ?? '', theirs = current[f.k] ?? '';
			if (mine === loaded) merged[f.k] = theirs;
			else if (theirs !== loaded && theirs !== mine) clash.push(f.label);
		}
		values = merged;
		version = r.version;
		base = current;
		saveError = null;
		rebaseNote = clash.length ? `${clash.join(', ')} ${clash.length > 1 ? 'were' : 'was'} also changed elsewhere; your typed ${clash.length > 1 ? 'values are' : 'value is'} kept.` : null;
	}
	// leaving the page drops the form: ask first when it holds unsaved input or a save is in flight (a page unload
	// gets the browser's own prompt)
	let leaving = false;
	beforeNavigate((nav) => {
		if (leaving || nav.type === 'form' || !(busy || unsaved)) return;
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		const url = nav.to.url;
		ask = { what: busy ? 'A save is still in progress; leaving now may not show whether it worked. Leave anyway?' : question(), go: () => { leaving = true; void goto(url).finally(() => { leaving = false; }); }, leave: true };
	});
	function exportNow() {
		if (reg.export.kind === 'ics') download(data.exportName.name, deadlineCalendar(data.exportRows, { now: now(), productId: data.icsProductId }), 'text/calendar;charset=utf-8');
		else download(data.exportName.name, registerCsv(reg, data.exportRows));
	}
</script>

<!-- the rows are complete when the page renders, so data-ready is set on the server too; data-hydrated marks that the
     form is interactive (tests type and click only after it) -->
<main id="main" tabindex="-1" data-ready={reg.view} data-hydrated={ready ? '' : undefined}>
	<PageHeader heading={reg.label} section={reg.label} caseName={data.version.titleName} subtitle={reg.subtitle}>
		{#snippet actions()}
			<button type="button" id="register-export" onclick={exportNow}>{reg.export.label}</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}
			<button type="submit" form="register-form" id="register-save" disabled={locked}>{editing ? 'Save' : 'Add'}</button>
			{#if editing}<button type="button" id="register-cancel" onclick={cancelEdit} disabled={locked}>Cancel</button>{/if}
		{/snippet}
	</PageHeader>

	<!-- multipart, so only the store's 64 KiB limit applies to an entry (an urlencoded body triples non-ASCII text) -->
	<form id="register-form" class="entry" method="POST" action="?/save" enctype="multipart/form-data" use:enhance={save} data-editing={editing ?? undefined} aria-busy={locked}>
		{#if editing}<input type="hidden" name="rowId" value={editing} /><input type="hidden" name="version" value={version ?? ''} />{/if}
		<fieldset class="fields" disabled={locked}>
			<legend class="visually-hidden">{editing ? 'Edit the entry' : 'New entry'}</legend>
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
		</fieldset>
	</form>
	{#if busy || deleting}<p class="status" role="status" id="register-status">{busy ? (editing ? 'Saving the change…' : 'Saving the entry…') : 'Deleting the entry…'}</p>{/if}
	{#if saveError}
		<div class="error" role="alert" id="register-error">
			<p>{saveError.message}</p>
			{#if saveError.retry}<button type="submit" form="register-form" id="register-retry" disabled={locked}>Retry</button>{/if}
			{#if saveError.draft}{@const d = saveError.draft}<button type="button" id="register-restore" onclick={() => restore(d)}>Restore the entry that was not saved</button>{/if}
			{#if saveError.stale && ready}{@const cur = data.rows.find((r) => r.rowId === editing)}{#if cur}<button type="button" id="register-rebase" onclick={() => rebase(cur)} disabled={busy}>Load the current entry and keep my changes</button>{/if}{/if}
			<a href={page.url.pathname} id="register-discard" onclick={discard}>Discard the entry</a>
			{#if !ready}<p id="register-nojs-note">Retry or discard this entry before you edit or delete another entry.</p>{/if}
		</div>
	{/if}
	{#if rebaseNote}<p class="status" role="status" id="register-rebase-note">{rebaseNote}</p>{/if}
	{#if deleteError}
		<div class="error" role="alert" id="register-delete-error">
			<p>{deleteError.message}</p>
			<button type="button" id="register-delete-dismiss" onclick={() => (deleteError = null)}>Dismiss</button>
		</div>
	{/if}
	{#if ask}
		<div class="ask" role="alertdialog" aria-labelledby="register-ask-text" id="register-ask">
			<p id="register-ask-text">{ask.what}</p>
			<button type="button" id="register-ask-discard" onclick={() => answer(true)}>Discard it</button>
			<button type="button" id="register-ask-keep" onclick={() => answer(false)}>Keep it</button>
		</div>
	{/if}

	<div class="table-wrap">
		<table id="register-table" data-rows={data.rows.length}>
			<thead><tr>{#each reg.columns as c (c.label)}<th class:end={c.num}>{c.label}</th>{/each}<th aria-label="Entry actions"></th></tr></thead>
			<tbody>
				{#if !data.rows.length}<tr><td colspan={reg.columns.length + 1}>{reg.empty}</td></tr>{/if}
				{#each data.rows as r (r.rowId)}
					<tr data-row-id={r.rowId} class:editing={editing === r.rowId} data-altered={r.intact ? undefined : ''}>
						{#each r.cells as c, i (i)}
							<td class:end={reg.columns[i]?.num}>
								{#if c.kind === 'chip'}<span class="chip tone-{c.tone}">{c.text}</span>
								{:else if c.kind === 'ref'}<CitationLink resultsVersion={vid} ref={c.target ?? c.text} label={c.text} exists={c.target !== null} />
								{:else}{c.text}{#if c.flag} <span class="flag" data-not-counted>({c.flag})</span>{/if}{/if}
							</td>
						{/each}
						<td class="row-actions">
							{#if !r.intact}<span class="altered">this entry was altered on disk since it was saved</span>{/if}
							<!-- without JavaScript a Delete would re-render the page without the refused save: off until it is resolved -->
							<button type="button" data-edit onclick={() => edit(r)} disabled={busy || deleting === r.rowId || (saveError !== null && !ready)}>Edit</button>
							<form method="POST" action="?/delete" use:enhance={remove}><input type="hidden" name="rowId" value={r.rowId} /><button data-delete disabled={busy || deleting === r.rowId || (saveError !== null && !ready)}>Delete</button></form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</main>

<style>
	.entry { margin: 1rem 0; }
	.fields { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; border: 0; padding: 0; margin: 0; min-width: 0; }
	.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.status { font-style: italic; }
	.error, .ask { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
	.error p, .ask p { margin: 0; }
	.ask { border: 1px solid currentColor; padding: 0.5rem; }
	.flag, .altered { font-size: 0.85em; color: #8a5a00; }
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
