<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { DEFENCE_CSV_NAME, REFS_HEADING, defenceCsv } from '$lib/views/analysis/defence';
	import '$lib/views/analysis/analysis.css';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	const h = $derived(data.headings);
	// S-vdm_matrix_tab-1: the free-text refs v5 never shows; the column is left out when no row has any
	const showRefs = $derived(data.rows.some((r) => r.refs.trim()));
	const exportCsv = () => download(DEFENCE_CSV_NAME, defenceCsv(data.rows));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'vdm_matrix_tab' : null}>
	<PageHeader heading="Defence & Rebuttal" section="Defence & Rebuttal" caseName={data.version.titleName} subtitle={data.subtitle}>
		{#snippet actions()}<button type="button" onclick={exportCsv} id="export-csv" disabled={data.rows.length === 0}>Export CSV</button>{/snippet}
	</PageHeader>
	{#if data.rows.length === 0}
		<div class="an-card"><div class="an-empty" id="defence-empty">No defence matrix in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><div class="an-scroll">
			<table class="an-table an-stack" id="defence-table">
				<thead><tr>{#each h as label, i (i)}<th>{label}</th>{/each}{#if showRefs}<th>{REFS_HEADING}</th>{/if}</tr></thead>
				<tbody>
					{#each data.rows as r, i (i)}
						<tr>
							<td data-label={h[0]} class="wrap"><b>{r.point}</b></td>
							<td data-label={h[1]} class="wrap">{r.dcs}</td>
							<td data-label={h[2]} class="wrap">{r.evidence}</td>
							<td data-label={h[3]}>{#if r.docs.length}<span class="chips">{#each r.docs as d, j (j)}{#if j}{' '}{/if}<CitationLink resultsVersion={vid} ref={d.ref} exists={known.has(d.ref)} />{/each}</span>{:else}<span class="an-tag">—</span>{/if}</td>
							<td data-label={h[4]} class="wrap">{r.rebuttal}</td>
							{#if showRefs}<td data-label={REFS_HEADING} class="wrap">{r.refs}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div></div>
		<p class="an-tag">Each document chip opens the source file in the viewer; the ref is the citation for pleadings and the court bundle.</p>
	{/if}
</main>
