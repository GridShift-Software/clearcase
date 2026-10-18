<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { REFS_HEADING, defenceCsv, refsShown } from '$lib/views/analysis/defence';
	import '$lib/views/analysis/analysis.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	const h = $derived(data.headings);
	const showRefs = $derived(refsShown(data.rows, data.analysisAdditions));
	const exportCsv = () => download(data.exportName.name, defenceCsv(data.exportColumns.keys, data.rows, data.analysisAdditions));
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="vdm_matrix_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading={data.heading} section="Defence & Rebuttal" caseName={data.version.titleName} subtitle={data.subtitle}>
		{#snippet actions()}<button type="button" onclick={exportCsv} id="export-csv" disabled={data.rows.length === 0}>Export CSV</button>{#each [data.exportName.note, data.exportColumns.note] as note, i (i)}{#if note}<span class="export-note" data-export-note>{note}</span>{/if}{/each}{/snippet}
	</PageHeader>
	{#if data.rows.length === 0}
		<div class="an-card"><div class="an-empty" id="defence-empty">No defence matrix in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><TableScroll label="Defence matrix" class="an-scroll">
			<table class="an-table an-stack" id="defence-table">
				<thead><tr>{#each h as label, i (i)}<th>{label}</th>{/each}{#if showRefs}<th>{REFS_HEADING}</th>{/if}</tr></thead>
				<tbody>
					{#each data.rows as r, i (i)}
						<tr>
							<td data-label={h[0]}><b>{r.point}</b></td>
							<td data-label={h[1]}>{r.dcs}</td>
							<td data-label={h[2]}>{r.evidence}</td>
							<td data-label={h[3]}>{#if r.docs.length}<span class="chips">{#each r.docs as d, j (j)}{#if j}{' '}{/if}<CitationLink resultsVersion={vid} ref={d.ref} exists={known.has(d.ref)} />{/each}</span>{:else}<span class="an-tag">—</span>{/if}</td>
							<td data-label={h[4]}>{r.rebuttal}</td>
							{#if showRefs}<td data-label={REFS_HEADING}>{r.refs}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</TableScroll></div>
		<p class="an-tag">Each document chip opens the source file in the viewer; the ref is the citation for pleadings and the court bundle.</p>
	{/if}
</main>
