<script lang="ts">
	import { docPath } from '../local-case/model.ts';
	let { resultsVersion, ref, page = null, exists = true, label = null, title = null }: { resultsVersion: string; ref: string; page?: number | null; exists?: boolean; label?: string | null; title?: string | null } = $props();
</script>

{#if exists}<a class="cite" href={docPath(resultsVersion, ref, page)} title={title ?? undefined}>{label ?? ref}{page ? ` p.${page}` : ''}</a>{:else}<span class="cite-broken" title="not in this results version">{label ?? ref}</span>{/if}
