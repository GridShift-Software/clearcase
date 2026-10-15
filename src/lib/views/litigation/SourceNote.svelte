<script lang="ts">
	let { text, more = null }: { text: string; more?: string | null } = $props();
</script>

<aside class="source-note" aria-labelledby="source-note-heading">
	<h2 id="source-note-heading">Source and scope</h2>
	<p data-source-note>{text}</p>
	{#if more}<p data-source-note-more>{more}</p>{/if}
</aside>

<style>
	.source-note { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 0.75rem; font-size: 13px; color: var(--ink-2); }
	.source-note h2 { font-size: 0.95rem; margin: 0 0 0.25rem; }
	.source-note p { margin: 0; }
	.source-note p + p { margin-top: 0.25rem; }
</style>
