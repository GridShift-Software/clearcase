<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { riskTone } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="risk_matrix_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Risk Matrix" section="Risk Matrix" caseName={data.version.titleName} subtitle="Issue · likelihood · impact · mitigation" />
	{#if data.risks.length === 0}
		<div class="an-card"><div class="an-empty" id="risk-empty">No risk matrix in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><TableScroll label="Risk matrix" class="an-scroll">
			<table class="an-table an-stack" id="risk-table">
				<thead><tr><th>Issue</th><th>Likelihood</th><th>Impact</th><th>Mitigation</th></tr></thead>
				<tbody>
					{#each data.risks as r, i (i)}
						<tr>
							<td data-label="Issue">{r.issue}</td>
							<td data-label="Likelihood"><span class="badge {riskTone(r.likelihood)}">{r.likelihood}</span></td>
							<td data-label="Impact"><span class="badge {riskTone(r.impact)}">{r.impact}</span></td>
							<td data-label="Mitigation">{r.mitigation}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableScroll></div>
	{/if}
</main>
