<script lang="ts">
	// Authored narrative with citations. The ONLY {@html} in the app: GRS-10 renderNarrative output, which escapes all
	// input and emits only <p>, <br>, <a class="cite" href> (app routes checked by isSafeAppHref) and span.cite-broken.
	import { narrativeHtml } from './cite.ts';
	let { text, resultsVersion, known }: { text: string; resultsVersion: string; known: readonly string[] } = $props();
	const html = $derived(narrativeHtml(text, resultsVersion, known));
</script>

<div class="narrative">{@html html}</div>
