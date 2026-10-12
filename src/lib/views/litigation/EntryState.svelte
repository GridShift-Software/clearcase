<script lang="ts">
	// The state of a register's add form (GRS-18 r2): the Add in flight, its own error with Retry and Discard, and the
	// note on an entry carried back without JavaScript. Retry and Discard sit outside the form, after it, so Add stays the
	// form's default button.
	import type { EntryForm } from './entry.svelte.ts';
	let { entry, form, errorId }: { entry: EntryForm; form: string; errorId: string } = $props();
</script>

<p class="status" role="status" data-saving={entry.adding ? '1' : null}>{entry.adding ? 'Saving the entry…' : ''}</p>
{#if entry.addError}
	<div class="entry-error" data-save-error>
		<p class="error" role="alert" id={errorId}>{entry.addError.message}</p>
		{#if entry.addError.retry}<button type="submit" {form} disabled={entry.adding} data-retry>Retry</button>{/if}
		<button type="button" onclick={entry.discard} disabled={entry.adding} data-discard>Discard</button>
	</div>
{:else if entry.note}
	<div class="entry-error" data-unsaved>
		<p class="note" role="status">{entry.note}</p>
		<button type="button" onclick={entry.discard} data-discard>Discard</button>
	</div>
{/if}
{#if entry.notice}<p class="note" role="status" data-delete-notice>{entry.notice}</p>{/if}

<style>
	.status:empty { display: none; }
	.status, .note { margin: 0.5rem 0 0; }
	.entry-error { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
	.entry-error p { margin: 0; flex: 1 1 100%; }
</style>
