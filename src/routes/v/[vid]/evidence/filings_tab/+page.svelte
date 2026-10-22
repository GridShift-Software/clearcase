<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate, beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '$app/forms';
	import { askFocus } from '$lib/components/ask-focus.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
	import { deleteStep } from '$lib/components/confirm-delete';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { docPath } from '$lib/local-case/model';
	import { cleanName, dateCell, docLabel, statusLabel } from '$lib/views/evidence/common';
	import { FORM_INPUTS, SAVE_FAILURES, entryNote, filingsCsvRows, registerCsvRows, rowVersion, saveFailure, type RegisterEntry, type SaveFailure } from '$lib/views/evidence/filings';
	import TableScroll from '$lib/components/TableScroll.svelte';
	type Values = Record<string, string>;
	type Result = { op?: 'add' | 'save' | 'delete'; code?: string; values?: Values; editing?: string | null; version?: string | null; message?: string; target?: string; confirm?: string | null; draft?: { values: Values; editing: string | null; version: string | null; failed: string | null } } | null;
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	const files = $derived(new Map(data.files));

	const blank = (): Values => Object.fromEntries(FORM_INPUTS.map((k) => [k, '']));
	const entryOf = (key: string | null | undefined): RegisterEntry | null => (key ? (data.entries.find((e) => e.key === key) ?? null) : null);
	const fieldsOf = (e: RegisterEntry | null): Values => (e ? Object.fromEntries(FORM_INPUTS.map((k) => [k, e.fields[k]])) : blank());
	const versionOf = (e: RegisterEntry | null) => (e ? rowVersion(e.fields) : null);
	const same = (x: Values, y: Values) => FORM_INPUTS.every((k) => (x[k] ?? '') === (y[k] ?? ''));
	type SaveError = { code: SaveFailure; message: string; retry: boolean };
	const failure = (code: SaveFailure): SaveError => ({ code, ...SAVE_FAILURES[code] });
	function initial(f: Result) {
		if (f?.op === 'save' && f.message) {
			const e = entryOf(f.editing);
			return { values: { ...blank(), ...f.values }, editing: e?.key ?? null, version: f.version ?? versionOf(e), saveError: failure(saveFailure(f.code) ?? 'busy'), deleteError: null, confirm: null };
		}
		if (f?.op === 'delete' && f.draft) {
			const e = entryOf(f.draft.editing);
			const code = f.draft.editing && !e ? 'gone' : saveFailure(f.draft.failed);
			return { values: { ...blank(), ...f.draft.values }, editing: e?.key ?? null, version: f.draft.version ?? versionOf(e), saveError: code ? failure(code) : null, deleteError: f.message ? { key: f.target ?? '', message: f.message } : null, confirm: f.confirm ?? null };
		}
		const e = entryOf(data.editing);
		return { values: fieldsOf(e), editing: e?.key ?? null, version: versionOf(e), saveError: null, deleteError: null, confirm: null };
	}
	const init = untrack(() => initial(form as Result));
	let values = $state<Values>(init.values);
	let editing = $state<string | null>(init.editing);
	let version = $state<string | null>(init.version);
	let base = $state<Values>(untrack(() => fieldsOf(entryOf(init.editing))));
	let saveError = $state<SaveError | null>(init.saveError);
	let deleteError = $state<{ key: string; message: string } | null>(init.deleteError);
	let busy = $state<{ op: 'add' | 'save' | 'delete'; key: string | null } | null>(null);
	// the row whose Delete awaits Confirm; without JavaScript the server's refusal names it
	let confirming = $state<string | null>(init.confirm);
	let ask = $state<{ what: string; go: () => void } | null>(null);
	const dirty = $derived(!same(values, base));
	const unsaved = $derived(dirty || saveError !== null);

	function load(key: string | null) {
		const e = entryOf(key);
		values = fieldsOf(e);
		base = fieldsOf(e);
		editing = e?.key ?? null;
		version = versionOf(e);
		saveError = null;
	}
	let landing = false;
	let navs = 0;
	let alive = true;
	afterNavigate((nav) => {
		navs++;
		if (nav.type !== 'enter') confirming = null;
		if (nav.type !== 'enter' && !(landing && editing === data.editing)) load(data.editing);
		landing = false;
	});
	const mark = () => ({ navs, href: page.url.href });
	const stayed = (at: { navs: number; href: string }) => alive && navs === at.navs && page.url.href === at.href;
	let leaving: string | null = null;
	const go = (url: URL | string) => {
		const href = new URL(url, page.url.href).href;
		leaving = href;
		void goto(href, { reset: false }).finally(() => { if (leaving === href) leaving = null; });
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

	const submit: SubmitFunction = ({ action, formData, cancel }) => {
		if (busy) { cancel(); return; }
		if (action.search === '?/delete') {
			const target = String(formData.get('delete') ?? '');
			const step = deleteStep(formData, target);
			confirming = step === 'ask' ? target : null;
			if (step !== 'confirm') { cancel(); return; }
			return remove(target);
		}
		const sent = { key: editing, version, values: { ...values }, at: mark() };
		busy = { op: editing ? 'save' : 'add', key: editing };
		saveError = null;
		ask = null;
		return async ({ result }) => {
			try {
				if (result.type === 'success' || result.type === 'redirect') {
					if (editing === sent.key && same(values, sent.values)) load(null);
					if (result.type === 'redirect' && stayed(sent.at)) {
						landing = editing === null;
						go(result.location);
					} else await invalidateAll();
				} else {
					const code = result.type === 'failure' ? (saveFailure(result.data?.code) ?? 'busy') : 'lost';
					values = sent.values;
					editing = code === 'gone' ? null : sent.key;
					version = code === 'gone' ? null : sent.version;
					saveError = failure(code);
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
	let ready = $state(false);
	onMount(() => { ready = true; return () => { alive = false; }; });
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
				<div><label class="fld" for="fl_status">Status</label><input class="in" id="fl_status" name="status" bind:value={values.status} /></div>
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
				<p id="register-delete-message">{deleteError.message}</p>
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
							<ConfirmDelete bind:pending={confirming} target={e.key} question="Delete this entry?" form="register-form" formaction="?/delete" name="delete" class="ghost" data-delete aria-describedby={deleteError?.key === e.key ? 'register-delete-message' : undefined} disabled={busy !== null || e.key === editing} title={e.key === editing ? 'Cancel the edit to delete this row' : undefined} />
						</td>
					</tr>
				{/each}
			</tbody>
		</table></TableScroll>
	</section>
</main>

<style>
	.group { margin-top: 1rem; }
	.chead { font-size: 15px; margin: 0 0 .3rem; padding: 0; border: 0; }
	.group-note, .register-intro { margin: 0 0 .4rem; }
	.ex, .entry-note { display: block; }
	.register { margin-top: 1rem; }
	.register-form .row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; border: 0; padding: 0; margin: 0; min-width: 0; }
	.status, .note { font-style: italic; }
	.error, .ask { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
	.error p, .ask p { margin: 0; }
	.ask { margin: .4rem 0; }
	.toolbar { margin: .6rem 0; }
	.actions form { display: inline; }
</style>
