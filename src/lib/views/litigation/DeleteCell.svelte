<script lang="ts">
	import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
	import type { EntryForm } from './entry.svelte.ts';
	let { entry, form, name, value }: { entry: EntryForm; form: string; name: 'rowId' | 'seedId'; value: string } = $props();
	const id = $derived(value.slice(0, value.lastIndexOf(' ') < 0 ? value.length : value.lastIndexOf(' ')));
</script>

<ConfirmDelete bind:pending={entry.confirming} target={value} question="Delete this entry?" label={entry.deleting[id] ? 'Deleting…' : 'Delete'} {form} formaction="?/delete" {name} class="ghost" data-delete disabled={!!entry.deleting[id]} aria-busy={entry.deleting[id] ? 'true' : null} />
{#if entry.deleteErrors[id]}
	<p class="error" role="alert" data-delete-error>{entry.deleteErrors[id]}</p>
	<button type="button" onclick={() => entry.dismissDelete(id)} data-dismiss>Dismiss</button>
{/if}

<style>
	p { margin: 0.25rem 0; max-width: 22rem; }
</style>
