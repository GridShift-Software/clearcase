<script lang="ts">
	import { revealInvisible } from './display';
	import type { NoteItem } from './model';
	// One note as plain text: the user's own words, never rendered as markup.
	let { note }: { note: NoteItem } = $props();
</script>

<p class="note-meta"><small>{note.createdAt.slice(0, 10)} · {note.target.kind === 'case' ? 'on the case' : note.target.kind === 'document' ? `on ${revealInvisible(note.target.ref)}` : `on ${revealInvisible(note.target.section)}`}</small></p>
<p class="note-body">{revealInvisible(note.body)}</p>

<style>
	.note-body { white-space: pre-wrap; overflow-wrap: anywhere; }
	.note-meta { overflow-wrap: anywhere; }
</style>
