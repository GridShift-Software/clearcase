<script lang="ts">
	import { narrativeHtml } from './cite.ts';
	let { text, resultsVersion, known }: { text: string; resultsVersion: string; known: readonly string[] } = $props();
	const html = $derived(narrativeHtml(text, resultsVersion, known));
</script>

<div class="narrative">{@html html}</div>
