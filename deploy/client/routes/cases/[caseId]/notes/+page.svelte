<script lang="ts">
	import { displayFilename } from '$lib/views/hosted/display';
	import NoteText from '$lib/views/hosted/NoteText.svelte';
	import type { NoteItem, NoteRefusal } from '$lib/views/hosted/model';
	type Data = { caseId: string; label: string; caseHref: string; chronologyHref: string | null; resultsVersion: string | null; notes: { state: 'available' | 'unavailable'; items: NoteItem[] }; operationId: string; saved: boolean; deleted: boolean; canWrite: boolean };
	let { data, form }: { data: Data; form: NoteRefusal | null } = $props();
	// After a refused save the server's current notes replace the loaded list, and the user's text stays in the form.
	const items = $derived(form?.notes ?? data.notes.items);
	const operationId = $derived(form?.op === 'add' ? (form.operationId ?? data.operationId) : data.operationId);
	// A refused annotation keeps its original version even after withdrawal or replacement, never silently a case note.
	const draftVersion = $derived(form?.op === 'add' ? (form.resultsVersion ?? data.resultsVersion) : data.resultsVersion);
	const draftRef = $derived(form?.op === 'add' ? (form.ref ?? '') : '');
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
	{#if form?.message}<p class="error" role="alert" id="note-error" data-op={form.op}>{form.message}</p>{/if}
	{#if form?.op === 'delete' && form.current}<div data-server-version={form.current.version}><p>The note as it is now on the server:</p><NoteText note={form.current} /></div>{/if}

	{#if data.canWrite}
	<form method="POST" action="?/add" id="note-form">
		<input type="hidden" name="operationId" value={operationId} />
		<label for="note-body">New note</label><br />
		<textarea id="note-body" name="body" rows="5" cols="60" maxlength="20000" required>{form?.op === 'add' ? (form.body ?? '') : ''}</textarea><br />
		{#if draftVersion || draftRef}
			<input type="hidden" name="resultsVersion" value={draftVersion ?? ''} />
			<label for="note-ref">Document ref (optional, to annotate a document of these results)</label><br />
			<input id="note-ref" name="ref" value={draftRef} /><br />
			{#if draftRef && draftVersion !== data.resultsVersion}<p data-note-target-moved>This draft still refers to {draftRef} in the results version you wrote it against. It cannot be saved while that version is not current; copy the text into a new note to choose another target.</p>{/if}
		{/if}
		<button type="submit" id="note-save">Save note</button>
	</form>
	{/if}

	{#if data.notes.state === 'unavailable' && !form?.notes}
		<p data-notes-unavailable>Your notes list is unavailable right now. Any unsaved text is kept in the form above; retry saving shortly. Nothing is saved in this browser instead.</p>
	{:else}
		<h2>{items.length} notes</h2>
		{#if items.length}
			<ul class="notes" data-testid="case-notes-list">
				{#each items as n, i (n.id)}
					<li data-note-id={n.id} data-note-version={n.version}>
						<NoteText note={n} />
						{#if data.canWrite}
							<form method="POST" action="?/delete">
								<input type="hidden" name="id" value={n.id} />
								<input type="hidden" name="version" value={n.version} />
								<input type="hidden" name="operationId" value={`${data.operationId}.d${i}`} />
								<button type="submit" data-action="delete-note">Delete</button>
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
