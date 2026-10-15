<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { paramsFromQuery, DEFAULT_QUERY } from '$lib/local-case/chronology';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { chart, importedMoney, invoicesCsv, reconcile, unitsMoney } from '$lib/views/quantum/ledger';
	import '$lib/views/quantum/quantum.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const q = $derived(data.quantum);
	const known = $derived(new Set(data.known));
	const c = $derived(q ? chart(q.amountDueSeries) : null);
	const rec = $derived(q ? reconcile(q) : null);
	const chargingHref = $derived(`/v/${encodeURIComponent(vid)}/chronology?${paramsFromQuery({ ...DEFAULT_QUERY, type: 'charging calculation' })}`);
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="quantum_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Quantum & Interest" section="Quantum & Interest" caseName={data.version.titleName} subtitle={data.content.subtitle} />
	{#if !q}
		<p>This results package has no quantum data.</p>
	{:else}
		<div class="q-kpis">
			<Kpi label="Amount due (to date)" value={importedMoney(q.headline_due)} sub="{q.headline_ref} · as at {q.headline_date}" />
			<Kpi label="Latest computation" sub={data.content.kpiLatestNote ?? ''}>{#if !q.headline_ref}—{:else if known.has(q.headline_ref)}<CitationLink resultsVersion={vid} ref={q.headline_ref} label="Open source PDF" />{:else}<CitationLink resultsVersion={vid} ref={q.headline_ref} exists={false} />{/if}</Kpi>
			<Kpi label="Invoices in ledger" value={q.invoiceCount.toLocaleString('en')} sub={data.content.kpiInvoicesNote ?? ''} />
			<Kpi label="Gross invoiced (unreconciled)" value={importedMoney(q.grossInvoiced)} sub="sum of invoice totals; pre-reconciliation" />
		</div>
		{#if rec && (!rec.countMatches || !rec.sumMatches)}
			<div class="q-flag" role="note" id="reconcile-flag">
				{#if !rec.countMatches}The imported invoice count ({q.invoiceCount.toLocaleString('en')}) differs from the ledger's {rec.ledgerLength.toLocaleString('en')} rows. {/if}
				{#if !rec.sumMatches}The imported gross invoiced figure ({importedMoney(q.grossInvoiced) || 'empty'}) differs from the sum of the ledger's amounts ({unitsMoney(rec.ledgerSum)}).{/if}
				Both imported figures are shown as the source gives them.
			</div>
		{/if}
		<div class="q-card">
			<h3>Running "Amount Due" balance (Post-Arb, Inv + Int)</h3>
			{#if c}
				<svg viewBox="0 0 {c.width} {c.height}" width="100%" height="160" role="img" aria-label="Amount due by date">{#each c.bars as b, i (i)}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill="#1E3A5F"><title>{b.title}</title></rect>{/each}</svg>
				<p class="tag">{c.caption}</p>
			{/if}
			<TableScroll label="Running amount due balance" class="q-wrap">
				<table class="q-tbl" id="amount-due-series">
					<thead><tr><th>As at</th><th>Ref</th><th class="num">Amount due</th><th>Source</th></tr></thead>
					<tbody>{#each q.amountDueSeries.toReversed() as s, i (i)}<tr><td class="mono">{s.date}</td><td class="mono">{s.ref}</td><td class="num">{importedMoney(s.amount)}</td><td><CitationLink resultsVersion={vid} ref={s.ref} exists={known.has(s.ref)} label={known.has(s.ref) ? 'open ↗' : s.ref} /></td></tr>{/each}</tbody>
				</table>
			</TableScroll>
		</div>
		<div class="q-two">
			<div class="q-card">
				<h3>Invoice ledger ({q.invoiceLedger.length})</h3>
				<div class="toolbar"><button type="button" id="export-invoices" onclick={() => download(data.exportName.name, invoicesCsv(q.invoiceLedger))}>Export CSV</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}</div>
				<TableScroll label="Invoice ledger" class="q-wrap q-h460">
					<table class="q-tbl" id="invoice-ledger">
						<thead><tr><th>Ref</th><th>Invoice</th><th>Date</th><th class="num">Amount</th><th>Doc</th></tr></thead>
						<tbody>{#each q.invoiceLedger as r, i (i)}<tr><td class="mono">{r.ref}</td><td class="mono">{r.no}</td><td class="mono">{r.date || '—'}</td><td class="num">{importedMoney(r.amount)}</td><td><CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={known.has(r.ref) ? 'open ↗' : r.ref} /></td></tr>{/each}</tbody>
					</table>
				</TableScroll>
			</div>
			<div class="q-card">
				<h3>Charging & statements</h3>
				<p>The charging calculations compare <b>supplied</b> vs <b>actual</b> units per day and underlie each invoice; the statement series tracks the running account.</p>
				<div class="q-row">
					<Kpi label="Charging calcs" value={String(q.chargingCount)} />
					<Kpi label="Statements" value={String(q.statementSeries.length)} />
					<Kpi label="Interest computations" value={String(q.interestSeries.length)} />
				</div>
				<p><a href={chargingHref} id="charging-link">View charging calculations →</a></p>
			</div>
		</div>
	{/if}
</main>

<style>
	.q-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: .8rem; }
</style>
