<script lang="ts">
	import { docPath } from '../local-case/model.ts';
	import { routeBase } from './shell.ts';
	let { resultsVersion, ref, page = null, exists = true, label = null, title = null }: { resultsVersion: string; ref: string; page?: number | null; exists?: boolean; label?: string | null; title?: string | null } = $props();
	const base = routeBase();
</script>

{#if exists}<a class="cite" href={docPath(resultsVersion, ref, page, base())} title={title ?? undefined}>{label ?? ref}{page ? ` p.${page}` : ''}</a>{:else}<span class="cite-broken" title="not in this results version">{label ?? ref}</span>{/if}
