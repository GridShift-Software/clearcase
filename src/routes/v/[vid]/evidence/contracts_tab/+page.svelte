<script lang="ts">
	import { onMount } from 'svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download, toCSV } from '$lib/components/csv';
	import { docPath } from '$lib/local-case/model';
	import { cleanName, dateCell, docLabel, statusLabel } from '$lib/views/evidence/common';
	import { contractsCsvRows, signedChip } from '$lib/views/evidence/contracts';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const c = $derived(data.contracts);
	const k = $derived(data.content);
	const files = $derived(new Map(data.files));
	const exportCsv = () => download('contracts.csv', toCSV(contractsCsvRows(c?.groups ?? [])));
	// the data is complete when the page renders (data-ready, also in the server's HTML); data-hydrated marks the
	// moment its controls respond
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="contracts_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Contracts" section="Contracts" caseName={data.version.titleName} subtitle={k.subtitle}>
		{#snippet actions()}<button type="button" id="export-contracts" onclick={exportCsv} disabled={!c}>Export CSV</button>{/snippet}
	</PageHeader>
	<p class="disclosure" id="classification-status" data-verification="unverified">Contract groups and the Signed marker are derived from imported titles and notes; they have not been verified.</p>
	{#if !c}<p class="warning">This results package has no contracts dataset.</p>{:else}
		<div class="grid kpis">
			<section class="card" aria-labelledby="kpi-contracts"><h2 id="kpi-contracts">Contract documents</h2><p class="num">{c.count}</p><p>across {c.groups.length} relationships</p></section>
			{#if k.spineValue}<section class="card" aria-labelledby="kpi-spine"><h2 id="kpi-spine">Spine of the claim</h2><p class="num text">{k.spineValue}</p>{#if k.spineNote}<p>{k.spineNote}</p>{/if}</section>{/if}
			{#if k.watchValue}<section class="card" aria-labelledby="kpi-watch"><h2 id="kpi-watch">Watch item</h2><p class="num text">{k.watchValue}</p>{#if k.watchNote}<p>{k.watchNote}</p>{/if}</section>{/if}
		</div>
		{#each c.groups as g, gi (gi)}
			<section class="card group" aria-labelledby="group-{gi}" data-group={gi}>
				<h2 id="group-{gi}" class="chead">{g.key} <span class="tag">({g.items.length})</span></h2>
				<table class="tbl">
					<thead><tr><th>Ref</th><th>Date</th><th>Contract</th><th>Signed</th><th>Text</th><th>Doc</th></tr></thead>
					<tbody>
						{#each g.items as x, i (i)}
							<tr data-ref={x.ref}>
								<td class="mono">{x.ref}</td><td class="mono">{dateCell(x.date)}</td>
								<td><div>{cleanName(x.title)}</div>{#if x.note}<div class="ex">{x.note}</div>{/if}</td>
								<td><span class="badge chip-{signedChip(x) === '—' ? 'none' : signedChip(x)}" title="Read from the title and note; not a verified execution status">{signedChip(x)}</span></td>
								<td>{statusLabel(x.text_status)}</td>
								<td>{#if files.get(x.ref)}<a class="doc" href={docPath(vid, x.ref)}>{docLabel(files.get(x.ref))}</a>{:else}<span class="cite-broken" title="not in this results version">not found</span>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/each}
		{#if k.counselNote}<section class="card narr" aria-labelledby="counsel-heading"><h2 id="counsel-heading">Why counsel needs this</h2><Narrative text={k.counselNote} resultsVersion={vid} known={[]} /></section>{/if}
	{/if}
</main>

<style>
	.kpis { margin-bottom: 1rem; }
	.num.text { text-align: left; font-weight: 600; }
	.group { margin-top: 1rem; }
	.chead { font-size: 1rem; margin: 0 0 .3rem; }
	.ex { display: block; color: #555; font-size: .85em; }
	.mono { font-family: ui-monospace, monospace; }
	.badge { display: inline-block; padding: 0 .4em; border-radius: 3px; background: #eef0f3; font-size: .85em; }
	.chip-signed { background: #e3f4e3; }
	.chip-unsigned { background: #fff1c2; }
	.disclosure { color: #6a4b00; }
	.narr { margin-top: 1rem; }
</style>
