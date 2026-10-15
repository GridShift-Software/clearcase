<script lang="ts">
	import type { EntryForm } from './entry.svelte.ts';
	let { entry, form, name, value }: { entry: EntryForm; form: string; name: 'rowId' | 'seedId'; value: string } = $props();
	const id = $derived(value.slice(0, value.lastIndexOf(' ') < 0 ? value.length : value.lastIndexOf(' ')));
</script>

<button type="submit" class="ghost" {form} formaction="?/delete" {name} {value} disabled={!!entry.deleting[id]} aria-busy={entry.deleting[id] ? 'true' : null}>{entry.deleting[id] ? 'Deleting…' : 'Delete'}</button>
{#if entry.deleteErrors[id]}
	<p class="error" role="alert" data-delete-error>{entry.deleteErrors[id]}</p>
	<button type="button" onclick={() => entry.dismissDelete(id)} data-dismiss>Dismiss</button>
{/if}

<style>
	p { margin: 0.25rem 0; max-width: 22rem; }
</style>
