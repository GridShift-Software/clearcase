<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { ANALYSIS_NOTE } from '$lib/views/litigation/notes';
	import { likelihoodClass } from '$lib/views/litigation/readonly';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const exists = $derived(new Set(data.exists));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<!-- the data is complete when the server renders the page, so data-ready is set from the start (the pilot checks read
	it from the served HTML); data-hydrated marks when the page's controls work -->
<main id="main" tabindex="-1" data-ready="legality_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Legality & SIU Risk" section="Legality & SIU Risk" caseName={data.version.titleName} subtitle={data.subtitle} />
	{#if !data.present}
		<div class="card"><div class="empty">This results package has no legality analysis.</div></div>
	{:else}
		<div class="card narr risk"><h3>The risk</h3>{#if data.intro}<Narrative text={data.intro} resultsVersion={vid} known={data.known} />{/if}</div>
		<div class="card pad0">
			<div class="chead">{data.docsHeading}</div>
			<div class="wrap"><TableScroll label={data.docsHeading}><table id="legality-docs">
				<thead><tr><th>Ref</th><th>Date</th><th>Document</th><th>Doc</th></tr></thead>
				<tbody>
					{#each data.docs as d, i (i)}
						<tr data-ref={d.ref}><td class="mono">{d.ref}</td><td class="mono">{d.date || '—'}</td><td>{d.title}</td><td><CitationLink resultsVersion={vid} ref={d.ref} exists={exists.has(d.ref)} label="open ↗" /></td></tr>
					{:else}
						<tr><td colspan="4"><div class="empty">No documents listed.</div></td></tr>
					{/each}
				</tbody>
			</table></TableScroll></div>
		</div>
		<div class="card"><h3>Scenarios</h3><div class="wrap"><TableScroll label="Scenarios"><table id="legality-scenarios">
			<thead><tr><th>Scenario</th><th>Effect on the claim</th><th>Likelihood</th><th>{data.actionHeading}</th></tr></thead>
			<tbody>
				{#each data.scenarios as x, i (i)}
					<tr><td><b>{x.scenario}</b></td><td class="ex"><Narrative text={x.effect} resultsVersion={vid} known={data.known} /></td><td><span class="badge {likelihoodClass(x.prob)}" data-chip={likelihoodClass(x.prob)}>{x.prob}</span></td><td class="ex"><Narrative text={x.action} resultsVersion={vid} known={data.known} /></td></tr>
				{:else}
					<tr><td colspan="4"><div class="empty">No scenarios listed.</div></td></tr>
				{/each}
			</tbody>
		</table></TableScroll></div></div>
		<div class="card"><h3>Factors to assess</h3><div class="wrap"><TableScroll label="Factors to assess"><table id="legality-factors">
			<thead><tr><th>Factor</th><th>Note</th></tr></thead>
			<tbody>
				{#each data.factors as x, i (i)}
					<tr><td><b>{x.factor}</b></td><td class="ex"><Narrative text={x.note} resultsVersion={vid} known={data.known} /></td></tr>
				{:else}
					<tr><td colspan="2"><div class="empty">No factors listed.</div></td></tr>
				{/each}
			</tbody>
		</table></TableScroll></div></div>
	{/if}
	<SourceNote text={ANALYSIS_NOTE} />
</main>

<style>
	.risk { border-left: 3px solid var(--danger); }
	.pad0 { padding: 0; }
</style>
