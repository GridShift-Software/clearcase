<script lang="ts">
	// Unsaved register input is never lost and never shown as saved (CC-04 r2). While a write is in flight the form,
	// Cancel, Retry and every row's Edit and Delete are inert and a status says so; a save's result applies to the row
	// and values it was submitted with. A refused save keeps its input with its error (and a Retry when trying again can
	// help) until that save succeeds, is retried or is discarded on purpose (Discard, or a confirmed Edit, Cancel or
	// navigation). Delete errors are kept apart and never clear a save failure, nor the reverse.
	// Without JavaScript a refused save re-renders with its values and row; a Delete posts the form's draft (a Delete
	// button is a submit button of the register form) and gets it back, done or refused; and while a refused save is
	// shown the rows' Edit buttons are inert, with a note, until it is retried or discarded.
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate, beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { askFocus } from '$lib/components/ask-focus.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { docPath } from '$lib/local-case/model';
	import { cleanName, dateCell, docLabel, statusLabel } from '$lib/views/evidence/common';
	import { INPUTS, SAVE_FAILURES, entryNote, filingsCsvRows, registerCsvRows, rowVersion, saveFailure, type RegisterEntry, type SaveFailure } from '$lib/views/evidence/filings';
	import TableScroll from '$lib/components/TableScroll.svelte';
	type Values = Record<string, string>;
	type Result = { op?: 'add' | 'save' | 'delete'; code?: string; values?: Values; editing?: string | null; version?: string | null; message?: string; target?: string; draft?: { values: Values; editing: string | null; version: string | null; failed: string | null } } | null;
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	const files = $derived(new Map(data.files));

	const blank = (): Values => Object.fromEntries(INPUTS.map((k) => [k, '']));
	const entryOf = (key: string | null | undefined): RegisterEntry | null => (key ? (data.entries.find((e) => e.key === key) ?? null) : null);
	const fieldsOf = (e: RegisterEntry | null): Values => (e ? Object.fromEntries(INPUTS.map((k) => [k, e.fields[k]])) : blank());
	const versionOf = (e: RegisterEntry | null) => (e ? rowVersion(e.fields) : null);
	const same = (x: Values, y: Values) => INPUTS.every((k) => (x[k] ?? '') === (y[k] ?? ''));
	type SaveError = { code: SaveFailure; message: string; retry: boolean };
	const failure = (code: SaveFailure): SaveError => ({ code, ...SAVE_FAILURES[code] });
	/** The form as the server rendered it: a refused save, or a Delete with the draft it carried (both only without
	 *  JavaScript), else the row the URL's ?edit= names. */
	function initial(f: Result) {
		if (f?.op === 'save' && f.message) {
			const e = entryOf(f.editing);
			return { values: { ...blank(), ...f.values }, editing: e?.key ?? null, version: f.version ?? versionOf(e), saveError: failure(saveFailure(f.code) ?? 'busy'), deleteError: null };
		}
		if (f?.op === 'delete' && f.draft) {
			const e = entryOf(f.draft.editing);
			// an edit draft of a row deleted elsewhere comes back in Add mode with the refusal that says so, never silently
			const code = f.draft.editing && !e ? 'gone' : saveFailure(f.draft.failed);
			return { values: { ...blank(), ...f.draft.values }, editing: e?.key ?? null, version: f.draft.version ?? versionOf(e), saveError: code ? failure(code) : null, deleteError: f.message ? { key: f.target ?? '', message: f.message } : null };
		}
		const e = entryOf(data.editing);
		return { values: fieldsOf(e), editing: e?.key ?? null, version: versionOf(e), saveError: null, deleteError: null };
	}
	const init = untrack(() => initial(form as Result));
	let values = $state<Values>(init.values);
	let editing = $state<string | null>(init.editing);
	/** the edited row's version as the form loaded it: a save from an older version is refused, never an overwrite */
	let version = $state<string | null>(init.version);
	/** the form as loaded: input that differs from it is unsaved */
	let base = $state<Values>(untrack(() => fieldsOf(entryOf(init.editing))));
	let saveError = $state<SaveError | null>(init.saveError);
	let deleteError = $state<{ key: string; message: string } | null>(init.deleteError);
	/** the write in flight, if any */
	let busy = $state<{ op: 'add' | 'save' | 'delete'; key: string | null } | null>(null);
	/** an action waiting for the user to confirm that the unsaved input may be discarded */
	let ask = $state<{ what: string; go: () => void } | null>(null);
	const dirty = $derived(!same(values, base));
	const unsaved = $derived(dirty || saveError !== null);

	/** Show the register with this row (or none) in the form, as loaded. */
	function load(key: string | null) {
		const e = entryOf(key);
		values = fieldsOf(e);
		base = fieldsOf(e);
		editing = e?.key ?? null;
		version = versionOf(e);
		saveError = null;
	}
	// Edit, Cancel and Back change the URL's ?edit=; the form follows once the navigation (confirmed, if it drops
	// unsaved input) is done. A completed save's redirect keeps the form it already emptied: the form is enabled before
	// the redirect lands, and text typed in between is the user's next entry. A save's redirect is followed only if the
	// user has not navigated since the save was sent (and this page is still shown); otherwise the user has gone
	// elsewhere on purpose and the redirect would pull them back and drop what they typed there.
	let landing = false;
	let navs = 0;
	let alive = true;
	afterNavigate((nav) => {
		navs++;
		if (nav.type !== 'enter' && !(landing && editing === data.editing)) load(data.editing);
		landing = false;
	});
	/** the navigation count and URL a write was sent at */
	const mark = () => ({ navs, href: page.url.href });
	const stayed = (at: { navs: number; href: string }) => alive && navs === at.navs && page.url.href === at.href;
	/** the one navigation this page starts itself (a confirmed one, or a save's redirect): it is not asked about again */
	let leaving: string | null = null;
	const go = (url: URL | string) => {
		const href = new URL(url, page.url).href;
		leaving = href;
		void goto(href, { noScroll: true, keepFocus: true }).finally(() => { if (leaving === href) leaving = null; });
	};
	const question = () => `${saveError ? 'The entry in the form was not saved.' : 'The entry in the form has changes that are not saved.'} Discard it?`;
	beforeNavigate((nav) => {
		if ((leaving !== null && nav.to?.url.href === leaving) || !(busy || unsaved)) return;
		// leaving the page gets the browser's own prompt; any other navigation asks here first
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		const url = nav.to.url;
		ask = { what: busy ? 'A change is still being saved; leaving now may not show whether it worked. Leave anyway?' : question(), go: () => go(url) };
	});
	const askFocusing = askFocus(() => ask !== null, 'register-ask', 'register-ask-keep');
	function answer(yes: boolean) {
		const a = ask;
		ask = null;
		if (yes && a) a.go();
		else askFocusing.back();
	}
	function discard(e: MouseEvent) {
		e.preventDefault();
		if (busy) return;
		load(null);
		if (page.url.search) go(page.url.pathname);
	}

	// One form posts Add, Save and every row's Delete: a Delete's result never touches the form or a save failure
	const submit: SubmitFunction = ({ submitter, cancel }) => {
		if (busy) { cancel(); return; }
		if (submitter?.getAttribute('name') === 'delete') return remove(submitter.getAttribute('value') ?? '');
		const sent = { key: editing, version, values: { ...values }, at: mark() };
		busy = { op: editing ? 'save' : 'add', key: editing };
		saveError = null;
		ask = null;
		return async ({ result }) => {
			try {
				if (result.type === 'success' || result.type === 'redirect') {
					// done: the form empties only while it still holds what was sent (it is inert in flight, so it does)
					if (editing === sent.key && same(values, sent.values)) load(null);
					if (result.type === 'redirect' && stayed(sent.at)) {
						landing = editing === null;
						go(result.location);
					} else await invalidateAll();
				} else {
					// refused or unanswered: the form shows what was sent, for the row it was sent for
					const code = result.type === 'failure' ? (saveFailure(result.data?.code) ?? 'busy') : 'lost';
					values = sent.values;
					// the row is gone: the form offers the Add its refusal names, as it does without JavaScript
					editing = code === 'gone' ? null : sent.key;
					version = code === 'gone' ? null : sent.version;
					saveError = failure(code);
					// deleted or changed elsewhere: the register shows the row as it is now, the form keeps the input
					if (result.type === 'failure' && (result.status === 404 || result.status === 409)) await invalidateAll();
				}
			} finally { busy = null; }
		};
	};
	function remove(target: string): ReturnType<SubmitFunction> {
		const at = mark();
		busy = { op: 'delete', key: target };
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					if (deleteError?.key === target) deleteError = null;
					await invalidateAll();
				} else if (result.type === 'failure') {
					deleteError = { key: target, message: String(result.data?.message ?? 'The entry could not be deleted; try again.') };
					if (result.status === 404) await invalidateAll();
				} else if (result.type === 'redirect') {
					if (stayed(at)) go(result.location);
					else await invalidateAll();
				} else deleteError = { key: target, message: 'The entry may not have been deleted: the app did not answer. Check the register, then try again.' };
			} finally { busy = null; }
		};
	}
	const exportFilings = () => download(data.exportNames.filings.name, toCSV(filingsCsvRows(data.groups ?? [])));
	const exportRegister = () => download(data.exportNames.register.name, toCSV(registerCsvRows(data.entries)));
	// the data is complete when the page renders (data-ready, also in the server's HTML); data-hydrated marks the
	// moment its controls respond
	let ready = $state(false);
	onMount(() => { ready = true; return () => { alive = false; }; });
	/** without JavaScript a row's Edit would drop a refused save's input: it waits until that is retried or discarded */
	const held = $derived(!ready && saveError !== null);
</script>

<main id="main" tabindex="-1" data-ready="filings_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Filings & Affidavits" section="Filings & Affidavits" caseName={data.version.titleName} subtitle={data.content.subtitle}>
		{#snippet actions()}<button type="button" id="export-filings" onclick={exportFilings} disabled={!data.groups}>Export CSV</button>{#if data.exportNames.filings.note}<span class="export-note" data-export-note>{data.exportNames.filings.note}</span>{/if}{/snippet}
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
			<TableScroll label={g.key}><table class="tbl">
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
			</table></TableScroll>
		</section>
	{/each}

	<section class="card register" aria-labelledby="register-heading">
		<h2 id="register-heading">Filing ↔ Replying-affidavit register</h2>
		<p class="register-intro">{data.content.registerIntro}</p>
		<form method="POST" action={editing ? '?/save' : '?/add'} class="register-form" use:enhance={submit} id="register-form" data-mode={editing ? 'edit' : 'add'} aria-busy={busy !== null}>
			{#if editing}<input type="hidden" name="key" value={editing} /><input type="hidden" name="version" value={version ?? ''} />{/if}
			{#if saveError}<input type="hidden" name="failed" value={saveError.code} />{/if}
			<fieldset class="row" disabled={busy !== null}>
				<div><label class="fld" for="fl_filing">Filing</label><input class="in" id="fl_filing" name="filing" bind:value={values.filing} /></div>
				<div><label class="fld" for="fl_fdate">Date</label><input class="in" id="fl_fdate" name="fdate" type="date" bind:value={values.fdate} /></div>
				<div><label class="fld" for="fl_fparty">Party filing</label><input class="in" id="fl_fparty" name="fparty" bind:value={values.fparty} /></div>
				<div><label class="fld" for="fl_response">Responding / replying affidavit</label><input class="in" id="fl_response" name="response" bind:value={values.response} /></div>
				<div><label class="fld" for="fl_rdate">Response date</label><input class="in" id="fl_rdate" name="rdate" type="date" bind:value={values.rdate} /></div>
				<div><label class="fld" for="fl_ref">Ref</label><input class="in" id="fl_ref" name="ref" bind:value={values.ref} /></div>
				<div class="submit">{#if editing}<button id="register-save">Save</button>{#if !saveError} <a href="?" id="register-cancel">Cancel</a>{/if}{:else}<button id="register-add">Add</button>{/if}</div>
			</fieldset>
			{#if busy}<p class="status" role="status" id="register-status">{busy.op === 'delete' ? 'Deleting the entry…' : busy.op === 'save' ? 'Saving the change…' : 'Adding the entry…'}</p>{/if}
			{#if saveError}
				<div class="error" role="alert" id="register-error" data-code={saveError.code}>
					<p>{saveError.message}</p>
					{#if saveError.retry}<button id="register-retry" disabled={busy !== null}>Retry</button>{/if}
					<a href="?" id="register-discard" onclick={discard}>Discard the entry</a>
				</div>
				{#if held}<p class="note" id="register-held">Retry or discard the unsaved entry before you edit another row.</p>{/if}
			{/if}
		</form>
		{#if deleteError}
			<div class="error" role="alert" id="register-delete-error" data-key={deleteError.key}>
				<p>{deleteError.message}</p>
				{#if ready}<button type="button" id="register-delete-dismiss" onclick={() => (deleteError = null)}>Dismiss</button>{/if}
			</div>
		{/if}
		{#if ask}
			<div class="ask" role="alertdialog" aria-labelledby="register-ask-text" id="register-ask">
				<p id="register-ask-text">{ask.what}</p>
				<button type="button" id="register-ask-discard" onclick={() => answer(true)}>Discard it</button>
				<button type="button" id="register-ask-keep" onclick={() => answer(false)}>Keep it</button>
			</div>
		{/if}
		<div class="toolbar"><button type="button" id="export-register" onclick={exportRegister}>Export register CSV</button>{#if data.exportNames.register.note}<span class="export-note" data-export-note>{data.exportNames.register.note}</span>{/if}</div>
		<TableScroll label="Filing register"><table class="tbl" id="filing-register">
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
							<form method="GET"><input type="hidden" name="edit" value={e.key} /><button class="ghost" data-edit disabled={busy !== null || held}>Edit</button></form>
							<button class="ghost" data-delete form="register-form" formaction="?/delete" name="delete" value={e.key} disabled={busy !== null || e.key === editing} title={e.key === editing ? 'Cancel the edit to delete this row' : undefined}>Delete</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table></TableScroll>
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
	.register-form .row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; border: 0; padding: 0; margin: 0; min-width: 0; }
	.status, .note { font-style: italic; color: #555; }
	.error, .ask { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
	.error p, .ask p { margin: 0; }
	.ask { border: 1px solid currentColor; padding: .5rem; margin: .4rem 0; }
	.fld { display: block; font-size: .85em; color: #555; }
	.toolbar { margin: .6rem 0; }
	.actions form { display: inline; }
	.disclosure { color: #6a4b00; }
	.empty { color: #666; padding: .4rem 0; }
</style>
