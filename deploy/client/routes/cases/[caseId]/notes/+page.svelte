<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
	import { deleteStep } from '$lib/components/confirm-delete';
	import { displayFilename } from '$lib/views/hosted/display';
	import NoteText from '$lib/views/hosted/NoteText.svelte';
	import LeaveGuard from '$lib/views/litigation/LeaveGuard.svelte';
	import type { NoteItem, NoteRefusal } from '$lib/views/hosted/model';
	type Data = { caseId: string; label: string; caseHref: string; chronologyHref: string | null; resultsVersion: string | null; notes: { state: 'available' | 'unavailable'; items: NoteItem[] }; operationId: string; saved: boolean; deleted: boolean; canWrite: boolean };
	let { data, form }: { data: Data; form: NoteRefusal | null } = $props();
	// After a refused save the server's current notes replace the loaded list, and the user's text stays in the form.
	const items = $derived(form?.notes ?? data.notes.items);
	// The draft is the page's own (GRS-284): a delete answers `form` and reloads `data` behind it, and neither may change
	// what is being written. A refused save's answer seeds it, and its retry identity and version stay with the text.
	let refused = $state.raw(untrack(() => (form?.op === 'add' ? form : null)));
	let body = $state(untrack(() => refused?.body ?? ''));
	let ref = $state(untrack(() => refused?.ref ?? ''));
	const operationId = $derived(refused?.operationId ?? data.operationId);
	// A refused annotation keeps its original version even after withdrawal or replacement, never silently a case note.
	const draftVersion = $derived(refused ? (refused.resultsVersion ?? data.resultsVersion) : data.resultsVersion);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	const unsaved = $derived(body.trim() !== '' || ref.trim() !== '');
	function discard() {
		refused = null;
		body = '';
		ref = '';
	}
	const saveNote: SubmitFunction = () => {
		saving = true;
		saveError = null;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					saveError = 'The note may not have been saved. Your text is kept; try again.';
					return;
				}
				if (result.type === 'success' || result.type === 'redirect') discard();
				await update({ reset: false });
				if (result.type === 'failure' && form?.op === 'add') refused = form;
			} finally {
				saving = false;
			}
		};
	};
	// the note whose Delete awaits Confirm; without JavaScript the server's answer names it
	let confirming = $state<string | null>(untrack(() => (form?.op === 'delete' ? (form.confirm ?? null) : null)));
	let deleting = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	// With JavaScript a confirmed delete is sent without a page load, so the draft stays as typed. An error answer would
	// replace the page, and the draft with it, so it is said here instead.
	const removeNote: SubmitFunction = ({ formData, cancel }) => {
		const id = String(formData.get('id'));
		const step = deleteStep(formData, id);
		if (step !== 'confirm') { cancel(); confirming = step === 'ask' ? id : null; return; }
		confirming = null;
		deleting = id;
		deleteError = null;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') deleteError = result.status && (result.error as { message?: string } | undefined)?.message || `The note was not deleted: ${result.status ? `the app answered ${result.status}.` : 'the app did not answer.'} Try again.`;
				else await update();
			} finally {
				deleting = null;
			}
		};
	};
</script>

<style>
	textarea { max-width: 100%; }
</style>

<main id="main" tabindex="-1" data-view="notes" data-user-work-state={data.notes.state}>
	<p><a href={data.caseHref}>{displayFilename(data.label)}</a> › Your notes</p>
	<h1>Your notes</h1>
	<p>Your notes are your own work on this case. They are saved on the server, not in this browser, and never depend on published results.</p>
	{#if data.saved && !form}<p role="status" data-note-saved>Note saved.</p>{/if}
	{#if data.deleted && !form}<p role="status" data-note-deleted>Note deleted.</p>{/if}
	{#if saveError}<p class="error" role="alert" id="note-save-error">{saveError}</p>{/if}
	{#if deleteError}<p class="error" role="alert" id="note-error" data-op="delete">{deleteError}</p>
	{:else if form?.message}<p class="error" role="alert" id="note-error" data-op={form.op}>{form.message}</p>{/if}
	{#if form?.op === 'delete' && form.current}<div data-server-version={form.current.version}><p>The note as it is now on the server:</p><NoteText note={form.current} /></div>{/if}

	{#if data.canWrite}
	<form method="POST" action="?/add" id="note-form" use:enhance={saveNote}>
		<input type="hidden" name="operationId" value={operationId} />
		<label for="note-body">New note</label><br />
		<textarea id="note-body" name="body" rows="5" cols="60" maxlength="20000" required readonly={saving} bind:value={body}></textarea><br />
		{#if draftVersion || refused?.ref}
			<input type="hidden" name="resultsVersion" value={draftVersion ?? ''} />
			<label for="note-ref">Document ref (optional, to annotate a document of these results)</label><br />
			<input id="note-ref" name="ref" readonly={saving} bind:value={ref} /><br />
			{#if ref && draftVersion !== data.resultsVersion}<p data-note-target-moved>This draft still refers to {ref} in the results version you wrote it against. It cannot be saved while that version is not current; copy the text into a new note to choose another target.</p>{/if}
		{/if}
		<button type="submit" id="note-save" disabled={saving}>Save note</button>
	</form>
	<LeaveGuard {unsaved} what="Your note is not saved." {discard} />
	{/if}

	{#if data.notes.state === 'unavailable' && !form?.notes}
		<p data-notes-unavailable>Your notes list is unavailable right now. Any unsaved text is kept in the form above; retry saving shortly. Nothing is saved in this browser instead.</p>
	{:else}
		<h2>{items.length} notes</h2>
		{#if items.length}
			<ul class="notes" data-testid="case-notes-list">
				{#each items as n (n.id)}
					<li data-note-id={n.id} data-note-version={n.version}>
						<NoteText note={n} />
						{#if data.canWrite}
							<form method="POST" action="?/delete" use:enhance={removeNote}>
								<input type="hidden" name="id" value={n.id} />
								<input type="hidden" name="version" value={n.version} />
								<input type="hidden" name="operationId" value={`${data.operationId}.d.${n.id}`} />
								<ConfirmDelete bind:pending={confirming} target={n.id} question="Delete this note?" data-action="delete-note" disabled={deleting === n.id} />
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p>No notes on this case yet.</p>
		{/if}
	{/if}
	{#if data.chronologyHref}<p><a data-action="open-chronology" href={data.chronologyHref}>Chronology</a></p>{/if}
</main>
