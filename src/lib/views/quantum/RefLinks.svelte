<script lang="ts">
	// A list of bare refs (v5 refLinks): each one that resolves in the version links to its document page, marked ↗
	// as v5 marks its document links; one that does not resolve renders visibly broken, never fuzzy-matched.
	import CitationLink from '../../components/CitationLink.svelte';
	let { refs, resultsVersion, known }: { refs: readonly string[]; resultsVersion: string; known: ReadonlySet<string> } = $props();
</script>

{#each refs as ref, i (i)}{#if i}{' '}{/if}<CitationLink {resultsVersion} {ref} exists={known.has(ref)} label={known.has(ref) ? `${ref} ↗` : ref} />{/each}
