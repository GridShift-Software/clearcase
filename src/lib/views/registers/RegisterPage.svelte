<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '$app/forms';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
	import { deleteStep } from '$lib/components/confirm-delete';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import { now } from '$lib/components/clock';
	import { download } from '$lib/components/csv';
	import { RELOAD_UNAVAILABLE, reloader } from '$lib/components/reload.svelte';
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
	type Form = { op?: 'save' | 'delete'; values?: Entry; rowId?: string | null; version?: string | null; message?: string; retry?: boolean; confirm?: string | null } | null;
	let { data, form }: { data: Data; form: Form } = $props();
	const reg = $derived(data.register);
	const vid = $derived(data.version.id);

	const blank = (): Entry => Object.fromEntries(reg.fields.map((f) => [f.k, f.type === 'select' && f.placeholder === undefined ? f.opts![0]! : '']));
	const saved = untrack(() => (form?.op === 'save' && form.message ? form : null));
	let values = $state<Entry>(untrack(() => ({ ...blank(), ...form?.values })));
	let editing = $state<string | null>(saved?.rowId ?? null);
	let version = $state<string | null>(saved?.version ?? null);
	let base = $state<Entry>(untrack(() => blank()));
	type Draft = { rowId: string | null; version: string | null; values: Entry };
	let saveError = $state<{ message: string; retry: boolean; stale?: boolean; draft?: Draft } | null>(saved ? { message: saved.message!, retry: saved.retry === true } : null);
	let deleteError = $state<{ rowId: string | null; message: string } | null>(untrack(() => (form?.op === 'delete' && form.message ? { rowId: form.rowId ?? null, message: form.message } : null)));
	let busy = $state(false);
	const rl = reloader();
	let deleting = $state<string | null>(null);
	// the row whose Delete awaits Confirm; without JavaScript the server's refusal names it
	let confirming = $state<string | null>(untrack(() => (form?.op === 'delete' ? (form.confirm ?? null) : null)));
	const locked = $derived(busy || (editing !== null && deleting === editing));
	let rebaseNote = $state<string | null>(null);
	let ask = $state<{ what: string; go: () => void; leave?: boolean } | null>(null);
	let ready = $state(false);
	onMount(() => { ready = true; });

	const dirty = $derived(reg.fields.some((f) => (values[f.k] ?? '') !== (base[f.k] ?? '')));
	const unsaved = $derived(dirty || saveError !== null);
	const question = () => `${saveError ? 'The entry in the form was not saved.' : 'The entry in the form has changes that are not saved.'} Discard it?`;
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

	const lost = (what: string, status?: number) =>
		status === 413 ? `${what} was not saved: it is too large to send. Nothing was changed and your input is kept; shorten it, then try again.`
		: `${what} may not have been saved: ${status ? `the app reported an error (${status})` : 'the app could not be reached'}. Your input is kept; check the list, then try again.`;

	const save: SubmitFunction = ({ cancel }) => {
		const why = unsavable(reg, values, editing !== null);
		if (why !== null) { cancel(); if (why) saveError = { message: why, retry: false }; return; }
		const sent: Draft = { rowId: editing, version, values: { ...values } };
		busy = true;
		saveError = null;
		rebaseNote = null;
		ask = null;
		return async ({ result }) => {
			try {
				const holds = editing === sent.rowId && reg.fields.every((f) => (values[f.k] ?? '') === (sent.values[f.k] ?? ''));
				if (result.type === 'success') {
					await rl.reload();
					if (holds) reset(sent.rowId ? {} : Object.fromEntries(reg.keepAfterAdd.map((k) => [k, sent.values[k]!])));
				} else if (result.type === 'redirect') await applyAction(result);
				else {
					const failed = result.type === 'failure'
						? { message: String(result.data?.message ?? 'The entry was not saved. Your input is kept; try again.'), retry: result.data?.retry === true, stale: result.status === 409 }
						: { message: lost(sent.rowId ? 'The change' : 'The entry', result.status), retry: result.status !== 413 };
					saveError = holds ? failed : { ...failed, retry: false, draft: sent };
					if (result.status === 404 || result.status === 409) await rl.reload();
				}
			} finally { busy = false; }
		};
	};
	const remove: SubmitFunction = ({ formData, cancel, formElement, submitter }) => {
		const id = String(formData.get('delete'));
		const step = deleteStep(formData, id);
		if (step !== 'confirm') { cancel(); confirming = step === 'ask' ? id : null; return; }
		const typed = reg.fields.some((f) => values[f.k] && !(f.type === 'select' && f.placeholder === undefined));
		if (id === editing && unsaved && typed) { cancel(); ask = { what: question(), go: () => { reset(); if (submitter instanceof HTMLButtonElement) formElement.requestSubmit(submitter); } }; return; }
		confirming = null;
		deleting = id;
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					if (deleteError && (deleteError.rowId === id || deleteError.rowId === null)) deleteError = null;
					if (editing === id) reset();
					await rl.reload();
				} else if (result.type === 'failure') deleteError = { rowId: id, message: String(result.data?.message ?? 'The deletion did not happen; try again.') };
				else if (result.type === 'redirect') await applyAction(result);
				else deleteError = { rowId: id, message: lost('The deletion', result.status).replace('may not have been saved', 'may not have happened').replace('was not saved', 'did not happen') };
			} finally { deleting = null; }
		};
	};
	const submit: SubmitFunction = (input) => input.action.search.includes('/delete') ? remove(input) : save(input);

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
	let opener: HTMLElement | null = null;
	$effect(() => {
		if (!ask) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || active === document.body) opener = null;
		else if (!active.closest('#register-ask')) opener = active;
		void tick().then(() => document.getElementById('register-ask-keep')?.focus());
	});
	onMount(() => {
		const h = () => setTimeout(() => { if (ask) document.getElementById('register-ask-keep')?.focus(); });
		addEventListener('popstate', h);
		return () => removeEventListener('popstate', h);
	});
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
		if (!a || (busy && !a.leave)) return;
		ask = null;
		if (yes) { saveError = null; base = { ...values }; a.go(); void focusFirst(firstField()); }
		else void focusFirst(opener, firstField());
	}
	function restore(d: Draft) {
		values = { ...blank(), ...d.values };
		editing = d.rowId;
		version = d.version;
		saveError = { message: saveError!.message, retry: true };
	}
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

<main id="main" tabindex="-1" data-ready={reg.view} data-hydrated={ready ? '' : undefined}>
	<PageHeader heading={reg.label} section={reg.label} caseName={data.version.titleName} subtitle={reg.subtitle}>
		{#snippet actions()}
			<button type="button" id="register-export" onclick={exportNow}>{reg.export.label}</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}
			<button type="submit" form="register-form" id="register-save" class="primary" disabled={locked}>{editing ? 'Save' : 'Add'}</button>
			{#if editing}<button type="button" id="register-cancel" onclick={cancelEdit} disabled={locked}>Cancel</button>{/if}
		{/snippet}
	</PageHeader>
	{#if rl.lost}<p class="error" role="alert" id="reload-error">{RELOAD_UNAVAILABLE}</p>{/if}

	<form id="register-form" class="entry" method="POST" action="?/save" enctype="multipart/form-data" use:enhance={submit} data-editing={editing ?? undefined} aria-busy={locked}>
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
			<p id="register-delete-message">{deleteError.message}</p>
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

	<TableScroll label={reg.label}>
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
							<button type="button" data-edit onclick={() => edit(r)} disabled={busy || deleting === r.rowId || (saveError !== null && !ready)}>Edit</button>
							<ConfirmDelete bind:pending={confirming} target={r.rowId} question="Delete this entry?" form="register-form" formaction="?/delete" name="delete" data-delete aria-describedby={deleteError?.rowId === r.rowId ? 'register-delete-message' : undefined} disabled={busy || deleting === r.rowId || (saveError !== null && !ready)} />
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableScroll>
</main>

<style>
	.entry { margin: 1rem 0; }
	.fields { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; border: 0; padding: 0; margin: 0; min-width: 0; }
	.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.status { font-style: italic; }
	.error, .ask { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
	.error p, .ask p { margin: 0; }
	.flag, .altered { font-size: 0.85em; color: #8a5a0b; }
	.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 10rem; }
	.field.wide { flex: 2; min-width: min(16rem, 100%); }
	.field textarea { min-height: 4rem; }
	td.end, th.end { text-align: end; }
	tr.editing { outline: 2px solid currentColor; }
	.row-actions { white-space: nowrap; }
</style>
