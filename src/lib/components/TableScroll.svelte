<script lang="ts">
	// The box a table scrolls in when it is wider than the viewport, so the page itself never scrolls sideways (BA-21,
	// GRS-62): a labelled region that a keyboard user focuses and scrolls with the arrow keys. It is a tab stop only
	// while its content overflows; without JavaScript, and until the first measure, it always is.
	// `class` adds global classes to the box (a height cap such as quantum's q-wrap q-h520).
	import type { Snippet } from 'svelte';
	let { label, class: extra = '', children }: { label: string; class?: string; children: Snippet } = $props();
	let box: HTMLDivElement;
	let overflows = $state(true);
	$effect(() => {
		const measure = () => { overflows = box.scrollWidth > box.clientWidth; };
		const ro = new ResizeObserver(measure);
		// the box changes with the viewport, its content with the rows it holds
		ro.observe(box);
		if (box.firstElementChild) ro.observe(box.firstElementChild);
		measure();
		return () => ro.disconnect();
	});
</script>

<!-- a scrollable region must take focus to be scrolled without a pointer (WCAG 2.1.1) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div bind:this={box} class="table-scroll {extra}" role="region" aria-label={label} tabindex={overflows ? 0 : undefined}>{@render children()}</div>
