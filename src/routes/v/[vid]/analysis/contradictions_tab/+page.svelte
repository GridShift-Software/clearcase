<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { money } from '$lib/components/format';
	import { CONTRADICTIONS_CSV_NAME, byCat, chipLabel, contradictionsCsv, rateCells, type Contradictions } from '$lib/views/analysis/contradictions';
	import { checkTone, severityBadge } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	// the page data carries package-keyed records as entries; rebuild them as own-property records here
	const c = $derived<Contradictions | null>(data.c ? {
		...data.c, byCat: Object.fromEntries(data.c.byCat),
		categories: data.c.categories.map((cat) => ({ ...cat, items: cat.items.map((it) => ({ ...it, rates: it.rates ? Object.fromEntries(it.rates) : undefined })) })),
	} : null);
	const exportCsv = () => { if (c) download(CONTRADICTIONS_CSV_NAME, contradictionsCsv(c)); };
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

{#snippet chips(refs: readonly { ref: string; amount: string | number; filename: string }[])}
	<span class="chips">{#each refs as r, j (j)}{#if j}{' '}{/if}<CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={chipLabel(r)} />{/each}</span>
{/snippet}

<main id="main" tabindex="-1" data-analysis data-ready="contradictions_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Contradiction Tracker" section="Contradiction Tracker" caseName={data.version.titleName} subtitle={c ? 'Inconsistencies computed automatically across the corpus at build time — no searching required' : null}>
		{#snippet actions()}{#if c}<button type="button" onclick={exportCsv} id="export-csv">Export CSV</button>{/if}{/snippet}
	</PageHeader>
	{#if !c}
		<div class="an-card"><div class="an-empty" id="contradictions-empty">No contradiction data.</div></div>
	{:else}
		<div class="an-kpis">
			<div class="kpi"><div class="k">Total flags</div><div class="v">{c.total}</div><div class="s">across {c.categories.length} categories</div></div>
			<div class="kpi"><div class="k">High severity</div><div class="v an-danger">{c.highCount}</div><div class="s">go to these first</div></div>
			<div class="kpi"><div class="k">Rate-conflict months</div><div class="v">{byCat(c, 'rate')}</div><div class="s">bid vs old vs new rate</div></div>
			<div class="kpi"><div class="k">Supplied-vs-actual pairs</div><div class="v">{byCat(c, 'units')}</div><div class="s">quantity-basis divergence</div></div>
		</div>
		<section class="an-card" aria-labelledby="checks-heading">
			<h2 id="checks-heading">Consistency checks</h2>
			<div class="an-scroll"><table class="an-table an-stack" id="checks-table">
				<thead><tr><th>Check</th><th>Result</th></tr></thead>
				<tbody>{#each c.checks as x, i (i)}{@const tone = checkTone(x.result)}<tr><td data-label="Check">{x.check}</td><td data-label="Result">{#if tone}<span class="badge {tone}">{x.result}</span>{:else}{x.result}{/if}</td></tr>{/each}</tbody>
			</table></div>
		</section>
		{#if c.categories.length === 0}<div class="an-card"><div class="an-empty" id="contradictions-none">No contradiction categories in this results version.</div></div>{/if}
		{#each c.categories as k, ci (ci)}
			{@const sev = severityBadge(k.severity)}
			<section class="an-card pad0 category" data-category={ci}>
				<p class="chead" role="heading" aria-level="2"><span class="badge {sev.cls}">{sev.label}</span><span class="ctitle">{k.title}</span><span class="an-tag count">{k.items.length} item(s)</span></p>
				<p class="explain">{k.explain}</p>
				<div class="an-scroll">
					{#if k.key === 'rate'}
						<table class="an-table an-stack">
							<thead><tr><th>Month</th><th class="num">Bid rate</th><th class="num">Old rate</th><th class="num">New / standard</th><th class="num">Spread</th><th>Sources</th></tr></thead>
							<tbody>{#each k.items as it, i (i)}{@const m = rateCells(it)}<tr>
								<td data-label="Month"><b>{it.label}</b></td>
								<td data-label="Bid rate" class="num">{m.bid}</td>
								<td data-label="Old rate" class="num">{m.old}</td>
								<td data-label="New / standard" class="num">{m.next}</td>
								<td data-label="Spread" class="num an-danger">{m.spread}</td>
								<td data-label="Sources">{@render chips(it.refs)}</td>
							</tr>{/each}</tbody>
						</table>
					{:else}
						<table class="an-table an-stack">
							<thead><tr><th>Item</th><th>Detail</th><th>Sources</th></tr></thead>
							<tbody>{#each k.items as it, i (i)}<tr>
								<td data-label="Item"><b>{it.label}</b></td>
								<td data-label="Detail">{it.detail}{#if it.spread}{' '}<b class="an-danger">Δ {money(it.spread)}</b>{/if}</td>
								<td data-label="Sources">{@render chips(it.refs)}</td>
							</tr>{/each}</tbody>
						</table>
					{/if}
				</div>
			</section>
		{/each}
		{#if data.methodNote}
			<section class="an-card" aria-labelledby="method-heading"><h2 id="method-heading">How this is produced</h2><p class="wrap">{data.methodNote}</p></section>
		{/if}
	{/if}
</main>

<style>
	.chead { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: 0; padding: .6rem .8rem; font-weight: 600; border-bottom: 1px solid #eee; }
	.chead .count { margin-left: auto; font-weight: 400; }
	.explain { margin: 0; padding: .6rem .8rem; color: #555; border-bottom: 1px solid #eee; }
</style>
