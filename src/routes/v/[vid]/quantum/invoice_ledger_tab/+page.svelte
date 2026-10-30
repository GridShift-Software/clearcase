<script lang="ts">
	import { onMount } from 'svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { importedMoney, invoicesCsv, ledgerSum, statusText, unitsMoney } from '$lib/views/quantum/ledger';
	import '$lib/views/quantum/quantum.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="invoice_ledger_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Invoice Ledger" section="Invoice Ledger" caseName={data.version.titleName} subtitle={data.subtitle}>
		{#snippet actions()}<button type="button" id="export-invoices" onclick={() => download(data.exportName.name, invoicesCsv(data.ledger))}>Export CSV</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}{/snippet}
	</PageHeader>
	<div class="q-kpis"><Kpi label="Gross invoiced (sum, unreconciled)" value={unitsMoney(ledgerSum(data.ledger))} sub="Authoritative claim = running Amount Due on the Quantum tab" /></div>
	<div class="q-card">
		<TableScroll label="Invoice ledger" class="q-wrap">
			<table class="q-tbl" id="invoice-ledger" data-open-col>
				<thead><tr><th>Ref</th><th>Invoice</th><th>Date</th><th>Bundle</th><th class="num">Amount</th><th>Status</th><th>Doc</th></tr></thead>
				<tbody>{#each data.ledger as r, i (i)}<tr><td class="mono">{r.ref}</td><td class="mono">{r.no}</td><td class="mono">{r.date || '—'}</td><td>{r.bundle}</td><td class="num">{importedMoney(r.amount)}</td><td>{statusText(r.text_status)}</td><td><CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={known.has(r.ref) ? 'open ↗' : r.ref} /></td></tr>{/each}</tbody>
			</table>
		</TableScroll>
	</div>
</main>
