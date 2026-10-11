<script lang="ts">
	// The scope disclosure every litigation view ends with (GRS-18 acceptance: label dataset scope and unverified legal
	// assertions). Generic wording only; the counts come from the imported data.
	// A register adds a second paragraph for the user's own rows (each paragraph is pinned whole in the parity register).
	let { text, more = null }: { text: string; more?: string | null } = $props();
</script>

<aside class="source-note" aria-labelledby="source-note-heading">
	<h2 id="source-note-heading">Source and scope</h2>
	<p data-source-note>{text}</p>
	{#if more}<p data-source-note-more>{more}</p>{/if}
</aside>

<style>
	.source-note { margin-top: 1.5rem; border-top: 1px solid #d5d9e0; padding-top: 0.5rem; font-size: 0.9rem; }
	.source-note h2 { font-size: 0.95rem; margin: 0 0 0.25rem; }
	.source-note p { margin: 0; }
	.source-note p + p { margin-top: 0.25rem; }
</style>
