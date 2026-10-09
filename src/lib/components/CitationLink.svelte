<script lang="ts">
	// A link to a cited document of the version being viewed; a ref that does not exist there renders visibly broken.
	import { docPath } from '../local-case/model.ts';
	let { resultsVersion, ref, page = null, exists = true, label = null }: { resultsVersion: string; ref: string; page?: number | null; exists?: boolean; label?: string | null } = $props();
</script>

{#if exists}<a class="cite" href={docPath(resultsVersion, ref, page)}>{label ?? ref}{page ? ` p.${page}` : ''}</a>{:else}<span class="cite-broken" title="not in this results version">{label ?? ref}</span>{/if}
