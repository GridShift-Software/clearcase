<script lang="ts">
	import { onMount } from 'svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SupplementalAnalysis from '$lib/views/analysis/SupplementalAnalysis.svelte';
	import '$lib/views/analysis/analysis.css';
	let { data } = $props();
	const m = $derived(data.matter);
	const vid = $derived(data.version.id);
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="matter" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Matter & Strategy" section="Matter & Strategy" caseName={data.version.titleName} subtitle={m?.title || null} />
	{#if !m}
		<div class="an-card"><div class="an-empty" id="matter-empty">No matter narrative in this results version.</div></div>
	{:else}
		<div class="an-two">
			{#each [['Storyline', m.storyline, 'storyline'], ['Strategy Memorandum', m.strategy, 'strategy']] as const as [title, items, id] (id)}
				<section class="an-card" aria-labelledby="matter-{id}" id="matter-{id}-card">
					<h2 id="matter-{id}">{title}</h2>
					{#each items as s, i (i)}
						<h3>{s.h}</h3>
						<Narrative text={s.t} resultsVersion={vid} known={data.known} />
					{:else}
						<div class="an-empty">No items in this results version.</div>
					{/each}
				</section>
			{/each}
		</div>
	{/if}
	<SupplementalAnalysis anchors={data.anchors} graph={data.graph} resultsVersion={vid} known={data.known} />
</main>
