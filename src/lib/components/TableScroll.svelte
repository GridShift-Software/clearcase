<script lang="ts">
	import type { Snippet } from 'svelte';
	let { label, class: extra = '', children }: { label: string; class?: string; children: Snippet } = $props();
	let box: HTMLDivElement;
	let overflows = $state(true);
	$effect(() => {
		const measure = () => { overflows = box.scrollWidth > box.clientWidth; };
		const ro = new ResizeObserver(measure);
		ro.observe(box);
		if (box.firstElementChild) ro.observe(box.firstElementChild);
		measure();
		return () => ro.disconnect();
	});
</script>

<!-- a scrollable region must take focus to be scrolled without a pointer (WCAG 2.1.1) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div bind:this={box} class="table-scroll {extra}" role="region" aria-label={label} tabindex={overflows ? 0 : undefined}>{@render children()}</div>
