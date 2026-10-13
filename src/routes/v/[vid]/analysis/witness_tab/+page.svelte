<script lang="ts">
	import { onMount } from 'svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import '$lib/views/analysis/analysis.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="witness_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Witnesses" section="Witnesses" caseName={data.version.titleName} subtitle="Will-say / witness statement index" />
	{#if data.witnesses.length === 0}
		<div class="an-card"><div class="an-empty" id="witness-empty">No witnesses in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><TableScroll label="Witnesses" class="an-scroll">
			<table class="an-table an-stack" id="witness-table">
				<thead><tr><th>Witness</th><th>Role</th><th>Will say</th></tr></thead>
				<tbody>
					{#each data.witnesses as w, i (i)}
						<tr>
							<td data-label="Witness"><b>{w.name}</b></td>
							<td data-label="Role">{w.role}</td>
							<td data-label="Will say" class="willsay"><Narrative text={w.willsay} resultsVersion={data.version.id} known={data.known} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableScroll></div>
	{/if}
</main>
