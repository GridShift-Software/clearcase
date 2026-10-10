<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { fmtR } from '$lib/components/format';
	import { centsText, importedUnits } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import RefLinks from '$lib/views/quantum/RefLinks.svelte';
	import { paymentsCsv, totals, type Payment } from '$lib/views/quantum/payments';
	import '$lib/views/quantum/quantum.css';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	const rows: Payment[] = $derived(data.payments.map((p) => ({ ...p, amountCents: p.amountCents === null ? null : BigInt(p.amountCents) })));
	const t = $derived(totals(importedUnits(data.claim) ?? 0n, rows));
	const R = (c: bigint) => fmtR(centsText(c));
	// S-payments_tab-4: the POD column shows only when some month has a proof-of-delivery ref
	const showPod = $derived(data.recon.some((m) => m.pod.length));
	// The add form's fields are bound state, so what the user typed survives any re-render (an error appearing, the
	// buttons disabling) until a successful add resets the form. After a refused add without JavaScript, the server's
	// answer carries the typed values back (a failed delete carries none).
	const typed = untrack(() => (form && 'values' in form && form.values && 'amount' in form.values ? form.values : null)) as Record<string, string> | null;
	let fields = $state({ date: typed?.date ?? '', amount: typed?.amount ?? '', method: typed?.method ?? '', note: typed?.note ?? '' });
	// a write that never reached the server (transport lost) keeps the form as typed and says so
	let transportError = $state<string | null>(null);
	let busy = $state(false);
	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'error') { transportError = 'Not saved: the app could not be reached. Your entry is kept; try again when it is running.'; return; }
			transportError = null;
			await update();
		};
	};
	const error = $derived(transportError ?? (form && 'error' in form ? (form.error as string) : null));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="payments_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Payments & Net Claim" section="Payments & Net Claim" caseName={data.version.titleName} subtitle={data.subtitle}>
		{#snippet actions()}<button type="button" id="export-payments" onclick={() => download('payments.csv', paymentsCsv(rows))}>Export payments</button>{/snippet}
	</PageHeader>
	<div class="q-kpis">
		<Kpi id="kpi-gross" label="Gross amount due" value={R(t.gross)} sub="as at {data.claimDate}" />
		<Kpi id="kpi-paid" label="Payments recorded" value={R(t.paid)} sub="{t.receipts} receipts{t.uncounted ? ` (${t.uncounted} not counted: not a valid amount)` : ''}" />
		<Kpi id="kpi-net" label="Net claim" value={R(t.net)} />
	</div>
	<div class="q-card">
		<h3>Record a payment received</h3>
		<form method="POST" action="?/add" use:enhance={submit} id="pay-form">
			<div class="q-row">
				<div><label for="pay_date">Date</label><input id="pay_date" name="date" type="date" bind:value={fields.date} /></div>
				<div><label for="pay_amount">Amount (R)</label><input id="pay_amount" name="amount" type="text" inputmode="decimal" autocomplete="off" bind:value={fields.amount} aria-invalid={form && 'field' in form && form.field === 'amount' ? 'true' : undefined} aria-describedby={error ? 'pay-error' : undefined} /></div>
				<div><label for="pay_method">Method / reference</label><input id="pay_method" name="method" type="text" bind:value={fields.method} /></div>
				<div class="q-grow2"><label for="pay_note">Note</label><input id="pay_note" name="note" type="text" bind:value={fields.note} /></div>
				<div class="q-tight"><button id="pay-add" disabled={busy}>Add</button></div>
			</div>
		</form>
		{#if error}<p class="error" role="alert" id="pay-error">{error}</p>{/if}
		<div class="q-wrap">
			<table class="q-tbl" id="payments">
				<thead><tr><th>Date</th><th class="num">Amount</th><th>Method</th><th>Note</th><th></th></tr></thead>
				<tbody>
					{#if !rows.length}<tr><td colspan="5">No payments recorded — the claim is currently gross.</td></tr>{/if}
					{#each rows as p (p.rowId)}
						<tr data-row-id={p.rowId}>
							<td class="mono">{p.date || '—'}</td>
							<td class="num">{#if p.amountCents !== null}{R(p.amountCents)}{:else}{p.amount} <small class="q-flag" data-not-counted>not counted: not a valid amount</small>{/if}</td>
							<td>{p.method}</td>
							<td>{p.note}</td>
							<td><form method="POST" action="?/delete" use:enhance={submit}><input type="hidden" name="rowId" value={p.rowId} /><button disabled={busy}>Delete</button></form></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
	<div class="q-card">
		<p class="q-chead">Monthly reconciliation chain ({data.recon.length} months) — invoice → statement → charging → proof of delivery → amount due</p>
		<div class="q-wrap q-h520">
			<table class="q-tbl" id="recon">
				<thead><tr><th>Month</th><th>Invoice</th><th>Supporting stmt</th><th>Charging</th>{#if showPod}<th>POD</th>{/if}<th>Statement</th><th>Amount due</th></tr></thead>
				<tbody>
					{#each data.recon as m, i (i)}
						<tr>
							<td class="mono">{m.month}</td>
							<td><RefLinks refs={m.invoice} resultsVersion={vid} {known} /></td>
							<td><RefLinks refs={m.supporting} resultsVersion={vid} {known} /></td>
							<td><RefLinks refs={m.charging} resultsVersion={vid} {known} /></td>
							{#if showPod}<td><RefLinks refs={m.pod} resultsVersion={vid} {known} /></td>{/if}
							<td><RefLinks refs={m.statement} resultsVersion={vid} {known} /></td>
							<td><RefLinks refs={m.amountdue} resultsVersion={vid} {known} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</main>
