<script lang="ts">
	// A link to a cited document of the version being viewed; a ref that does not exist there renders visibly broken.
	// `title` (imported text, e.g. a file name) is a tooltip on the link only; null renders no attribute.
	import { docPath } from '../local-case/model.ts';
	let { resultsVersion, ref, page = null, exists = true, label = null, title = null }: { resultsVersion: string; ref: string; page?: number | null; exists?: boolean; label?: string | null; title?: string | null } = $props();
</script>

{#if exists}<a class="cite" href={docPath(resultsVersion, ref, page)} title={title ?? undefined}>{label ?? ref}{page ? ` p.${page}` : ''}</a>{:else}<span class="cite-broken" title="not in this results version">{label ?? ref}</span>{/if}
