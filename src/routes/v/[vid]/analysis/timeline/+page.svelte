<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { viewById, viewHref } from '$lib/components/views';
	import { cleanName, type TimelineEvent } from '$lib/views/analysis/timeline';
	import '$lib/views/analysis/analysis.css';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	const c = $derived(data.content);
	const href = (id: string) => viewHref(vid, viewById(id)!);
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

{#snippet event(e: TimelineEvent)}
	<!-- S-double-escape: the title is shown once, as text (v5 escapes it twice, so '&amp;' is visible there) -->
	<div class="ev" role="listitem"><span class="d">{e.date}</span> · <span class="badge b-mut">{e.kind}</span> <span class="mono">{e.ref}</span> <CitationLink resultsVersion={vid} ref={e.ref} exists={known.has(e.ref)} label="{cleanName(e.title)} ↗" />{#if e.note}<div class="ex">{e.note}</div>{/if}</div>
{/snippet}

<main id="main" tabindex="-1" data-analysis data-ready="timeline" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Timeline" section="Timeline" caseName={data.version.titleName} subtitle={c.subtitle}>
		{#snippet actions()}<button type="button" onclick={() => window.print()} id="print">Print / PDF</button> <button type="button" onclick={() => goto(href('chronology'))} id="full-chronology">Full chronology</button>{/snippet}
	</PageHeader>

	{#if c.synopsis || c.narrative || c.amountDueNote}
		<div class="card tl-card narr" id="synopsis">
			<h2>Synopsis</h2>
			{#if c.synopsis}<p class="wrap">{c.synopsis}</p>{/if}
			{#if c.narrative}<p class="wrap">{c.narrative}</p>{/if}
			{#if c.amountDueNote}
				<div class="callout">{#each c.amountDueNote as part, i (i)}{#if 'link' in part}<CitationLink resultsVersion={vid} ref={data.headlineRef ?? ''} exists={!!data.headlineRef && known.has(data.headlineRef)} label="source ↗" />{:else}{part.text}{/if}{/each}</div>
			{/if}
		</div>
	{/if}

	<div class="card tl-card" id="years">
		<h2>Documents by year</h2>
		{#if data.years.length}
			<div class="years">{#each data.years as y (y.year)}<div class="year"><svg class="bar" viewBox="0 0 10 100" preserveAspectRatio="none" role="img" aria-label="{y.year}: {y.count}" data-height={y.height}><title>{y.year}: {y.count}</title><rect x="0" y={100 - y.height} width="10" height={y.height} /></svg><div class="an-tag">{y.label}</div><div class="an-tag">{y.count}</div></div>{/each}</div>
		{:else}
			<p class="an-empty">No documents-by-year counts in this results version.</p>
		{/if}
	</div>

	<div class="card tl-card" id="phases">
		<h2>Phased timeline</h2>
		{#if data.phases.length === 0 && data.unplaced.length === 0}
			<p class="an-empty">No timeline phases or events in this results version.</p>
		{:else}
			<div class="tl">
				{#each data.phases as ph, i (i)}
					<div class="ph" data-phase={i}>
						<div class="yr">{ph.label}</div>
						<h3>{ph.title}</h3>
						<p class="phnote">{ph.note}</p>
						<div role="list">
							{#each ph.events as e, j (j)}{@render event(e)}{:else}<div class="ev" role="listitem"><span class="ex">{c.emptyPhaseNote ?? 'No events are listed for this phase.'}</span></div>{/each}
						</div>
					</div>
				{/each}
				{#if data.unplaced.length}
					<div class="ph" data-phase="unplaced">
						<h3>Outside every phase</h3>
						<p class="phnote">These events have no date, or a year no phase covers.</p>
						<div role="list">{#each data.unplaced as e, j (j)}{@render event(e)}{/each}</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<div class="card tl-card" id="quantum">
		<h2>Quantum trajectory</h2>
		{#if c.quantumTrajectory}<p class="wrap">{c.quantumTrajectory}</p>{/if}
		{#if data.chart}
			<svg viewBox="0 0 {data.chart.width} {data.chart.height}" width="100%" height="160" role="img" aria-label="Amount due over time">
				{#each data.chart.bars as b, i (i)}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill="#1E3A5F"><title>{b.title}</title></rect>{/each}
			</svg>
			<div class="an-tag">{data.chart.caption}</div>
		{/if}
		<p><a href={href('quantum_tab')}>Open the Quantum &amp; Interest tab →</a></p>
	</div>

	<div class="card tl-card" id="correspondents">
		<h2>Principal correspondents</h2>
		{#if c.correspondentsIntro}<p class="wrap">{c.correspondentsIntro}</p>{/if}
		{#if data.people.length}
			<div class="an-scroll"><table class="an-table an-stack">
				<thead><tr><th>Name</th><th>Email</th><th>Organisation</th><th class="num">Touchpoints</th></tr></thead>
				<tbody>{#each data.people as p, i (i)}<tr><td data-label="Name">{p.name}</td><td data-label="Email" class="mono">{p.email}</td><td data-label="Organisation">{p.org || '—'}</td><td data-label="Touchpoints" class="num">{p.total}</td></tr>{/each}</tbody>
			</table></div>
		{:else}
			<p class="an-empty">No correspondents in this results version.</p>
		{/if}
	</div>

	<div class="card tl-card narr" id="evidence-notes">
		<h2>Evidence notes</h2>
		{#if c.evidenceNotes}<p class="wrap">{c.evidenceNotes}</p>{/if}
		<p class="an-tag">This is a working chronology for counsel, not a pleading.</p>
	</div>
</main>

<style>
	.tl-card { margin-bottom: 1rem; }
	.tl-card h2 { font-size: 1.05rem; margin: .2rem 0 .5rem; }
	.callout { background: #f3f6fa; border: 1px solid #1e3a5f; border-radius: 6px; padding: .6rem .9rem; margin-top: .5rem; }
	.years { display: flex; align-items: flex-end; gap: 6px; height: 140px; }
	.year { flex: 1; text-align: center; min-width: 0; }
	.bar { display: block; width: 100%; height: 100px; fill: #1e3a5f; }
	.ph { border-left: 3px solid #1e3a5f; padding: .2rem 0 .6rem .9rem; margin-bottom: .6rem; }
	.ph h3 { margin: .1rem 0; font-size: 1rem; }
	.yr { font-weight: 700; color: #1e3a5f; }
	.phnote { color: #555; margin: 0 0 .5rem; max-width: 860px; }
	.ev { padding: .15rem 0; overflow-wrap: anywhere; }
	.ev .d { font-variant-numeric: tabular-nums; }
	.ev .ex { display: block; color: #555; font-size: .92em; }
	.mono { font-family: ui-monospace, monospace; font-size: .92em; }
	@media print {
		.tl-card { break-inside: avoid-page; border: 0; }
		.ph { break-inside: avoid; }
	}
</style>
