<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { riskTone } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known ?? []));
	// a column for each field some risk of this generation carries; v5 carries none, so its four columns stay
	const show = $derived({ category: data.risks.some((r) => r.category), owner: data.risks.some((r) => r.owner), refs: data.risks.some((r) => r.refs?.length) });
	const subtitle = $derived(['Issue', show.category && 'category', 'likelihood', 'impact', 'mitigation', show.owner && 'owner', show.refs && 'documents'].filter(Boolean).join(' · '));
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="risk_matrix_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Risk Matrix" section="Risk Matrix" caseName={data.version.titleName} {subtitle} />
	{#if data.risks.length === 0}
		<div class="an-card"><div class="an-empty" id="risk-empty">No risk matrix in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><TableScroll label="Risk matrix" class="an-scroll">
			<table class="an-table an-stack" id="risk-table">
				<thead><tr><th>Issue</th>{#if show.category}<th>Category</th>{/if}<th>Likelihood</th><th>Impact</th><th>Mitigation</th>{#if show.owner}<th>Owner</th>{/if}{#if show.refs}<th>Documents</th>{/if}</tr></thead>
				<tbody>
					{#each data.risks as r, i (i)}
						<tr>
							<td data-label="Issue">{r.issue}</td>
							{#if show.category}<td data-label="Category">{#if r.category}<span class="badge">{r.category}</span>{/if}</td>{/if}
							<td data-label="Likelihood"><span class="badge {riskTone(r.likelihood)}">{r.likelihood}{#if r.likelihoodScore !== null}{' '}({r.likelihoodScore}){/if}</span></td>
							<td data-label="Impact"><span class="badge {riskTone(r.impact)}">{r.impact}{#if r.impactScore !== null}{' '}({r.impactScore}){/if}</span></td>
							<td data-label="Mitigation">{r.mitigation}</td>
							{#if show.owner}<td data-label="Owner">{r.owner ?? ''}</td>{/if}
							{#if show.refs}<td data-label="Documents">{#if r.refs?.length}<span class="chips">{#each r.refs as ref, j (j)}{#if j}{' '}{/if}<CitationLink resultsVersion={vid} {ref} exists={known.has(ref)} />{/each}</span>{:else}<span class="an-tag">—</span>{/if}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</TableScroll></div>
	{/if}
</main>
