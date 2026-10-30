<script lang="ts">
	import { revealInvisible } from './display';
	import type { PageNoteItem } from './page-note-items';
	// One page note as plain text, with the way back to its original's page. It is changed or deleted in the viewer only.
	let { note, elsewhere = false }: { note: PageNoteItem; elsewhere?: boolean } = $props();
</script>

<p class="note-meta"><small>{note.createdAt.slice(0, 10)} · page {note.page} of original {revealInvisible(note.assetId)}{elsewhere ? ', which has the same bytes as this document’s original' : ''}</small></p>
<p class="note-body">{revealInvisible(note.body)}</p>
{#if !note.intact}<p><strong class="unresolved" data-note-integrity="mismatch">this note was altered in storage since it was saved</strong></p>{/if}
<p><a data-action="open-page-note" href={note.href}>Open page {note.page} in the viewer</a> <small>(change or delete it there)</small></p>

<style>
	.note-body { white-space: pre-wrap; overflow-wrap: anywhere; }
	.note-meta { overflow-wrap: anywhere; }
</style>
