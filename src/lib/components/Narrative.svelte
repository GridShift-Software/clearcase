<script lang="ts">
	import { documentRoute, renderNarrative } from '../case-package/browser.ts';
	import { routeBase } from './shell.ts';
	let { text, resultsVersion, known }: { text: string; resultsVersion: string; known: readonly string[] } = $props();
	const base = routeBase();
	const html = $derived.by(() => {
		const set = new Set(known), b = base();
		return renderNarrative(text, { resolveCitationHref: (ref, page) => (set.has(ref) ? documentRoute(resultsVersion, ref, page, b) : null) });
	});
</script>

<div class="narrative">{@html html}</div>
