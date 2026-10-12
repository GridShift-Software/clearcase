<script lang="ts">
	// The box a table scrolls in when it is wider than the viewport, so the page itself never scrolls sideways (BA-21,
	// GRS-62): a labelled region in the tab order, which a keyboard user focuses and scrolls with the arrow keys.
	// `class` adds global classes to the box (a height cap such as quantum's q-wrap q-h520).
	import type { Snippet } from 'svelte';
	let { label, class: extra = '', children }: { label: string; class?: string; children: Snippet } = $props();
</script>

<!-- a scrollable region must take focus to be scrolled without a pointer (WCAG 2.1.1) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="table-scroll {extra}" role="region" aria-label={label} tabindex="0">{@render children()}</div>
