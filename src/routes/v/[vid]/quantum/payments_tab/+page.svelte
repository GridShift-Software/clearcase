<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import { fmtR } from '$lib/components/format';
	import { centsText, importedUnits } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import RefLinks from '$lib/views/quantum/RefLinks.svelte';
	import { checkEntry, MAX_LENGTH, paymentsCsv, totals, type EntryField, type Payment } from '$lib/views/quantum/payments';
	import '$lib/views/quantum/quantum.css';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	const rows: (Payment & { hash: string })[] = $derived(data.payments.map((p) => ({ ...p, amountCents: p.amountCents === null ? null : BigInt(p.amountCents) })));
	const t = $derived(totals(importedUnits(data.claim) ?? 0n, rows));
	const R = (c: bigint) => fmtR(centsText(c));
	// S-payments_tab-4: the POD column shows only when some month has a proof-of-delivery ref
	const showPod = $derived(data.recon.some((m) => m.pod.length));

	// An entry typed into the Add form is never lost and never shown as saved (CC-06 r2, D1 to D4). Each action keeps its
	// own state: the Add's failure (with Retry and Discard) stays until that entry is saved, retried or discarded; a
	// Delete's failure shows by its row; neither clears the other. An Add's result applies to what it submitted: on
	// success only the fields still holding the submitted text are cleared, so text typed while it was in flight
	// stays. Without JavaScript every answer (an Add's or a Delete's, which is submitted through the Add form) carries
	// the typed entry back, and a refused entry's reason with it.
	type Entry = Record<EntryField, string>;
	type Answer = { op?: 'add' | 'delete'; values?: Entry; error?: string; field?: EntryField | null; retry?: boolean; rowId?: string; gone?: boolean; addError?: string } | null;
	const FIELDS = ['date', 'amount', 'method', 'note'] as const;
	const blank = (): Entry => ({ date: '', amount: '', method: '', note: '' });
	const answered = untrack(() => form as unknown as Answer);
	let fields = $state<Entry>({ ...blank(), ...answered?.values });
	let addError = $state<{ message: string; field: EntryField | null; retry: boolean } | null>(
		answered?.op === 'add' && answered.error ? { message: answered.error, field: answered.field ?? null, retry: answered.retry === true }
		: answered?.op === 'delete' && answered.addError ? { message: answered.addError, field: answered.field ?? null, retry: false } : null);
	let deleteErrors = $state<Record<string, string>>(answered?.op === 'delete' && answered.error && !answered.gone && answered.rowId ? { [answered.rowId]: answered.error } : {});
	let goneNotice = $state<string | null>(answered?.op === 'delete' && answered.gone && answered.error ? answered.error : null);
	/** the entry an Add in flight submitted, and the row whose Delete is in flight */
	let sending = $state<Entry | null>(null);
	let deleting = $state<string | null>(null);
	const busy = $derived(sending !== null || deleting !== null);
	const unsaved = $derived(sending !== null || addError !== null || FIELDS.some((k) => fields[k] !== ''));
	/** a navigation waiting for the user to confirm that the unsaved entry may be dropped */
	let ask = $state<{ what: string; go: () => void } | null>(null);

	// the request may or may not have reached the app; a 413 is refused before the action runs, so nothing was saved
	const lost = (status?: number) =>
		status === 413 ? 'Not saved: the entry is too large to send. Your entry is kept; shorten it, then add it again.'
		: status ? `Not saved: the app reported an error (${status}). Your entry is kept; check the table, then try again.`
		: 'Not saved: the app could not be reached. Your entry is kept; try again when it is running.';

	const add: SubmitFunction = ({ cancel }) => {
		const sent = { ...fields };
		// an over-long field is refused here too, so it never meets the server's body limit (a 413)
		const c = checkEntry(sent);
		if (!c.ok && sent[c.field].length > MAX_LENGTH[c.field]) { cancel(); addError = { message: c.error, field: c.field, retry: false }; return; }
		addError = null;
		sending = sent;
		return async ({ result, update }) => {
			try {
				if (result.type === 'success') {
					await update({ reset: false });
					for (const k of FIELDS) if (fields[k] === sent[k]) fields[k] = '';
				} else if (result.type === 'failure') {
					addError = { message: String(result.data?.error ?? 'Not saved. Your entry is kept.'), field: (result.data?.field as EntryField | undefined) ?? null, retry: result.data?.retry === true };
				} else if (result.type === 'redirect') await applyAction(result);
				else addError = { message: lost(result.status), field: null, retry: result.status !== 413 };
			} finally { sending = null; }
		};
	};
	const remove = (id: string): ReturnType<SubmitFunction> => {
		deleting = id;
		goneNotice = null;
		const { [id]: _, ...rest } = deleteErrors;
		deleteErrors = rest;
		return async ({ result }) => {
			try {
				if (result.type === 'success') await invalidateAll();
				else if (result.type === 'failure') {
					const message = String(result.data?.error ?? 'Not deleted; try again.');
					if (result.data?.gone) goneNotice = message;
					else deleteErrors = { ...deleteErrors, [id]: message };
					// gone or changed elsewhere: the table shows the payments as stored now
					if (result.status === 404 || result.status === 409) await invalidateAll();
				} else if (result.type === 'redirect') await applyAction(result);
				else deleteErrors = { ...deleteErrors, [id]: lost(result.status).replace('Not saved', 'Not deleted').replace('Your entry is kept; check the table, then try again', 'Check the table, then try again').replace('Your entry is kept; try again', 'Try again') };
			} finally { deleting = null; }
		};
	};
	/** one form: its Add button adds, each row's Delete button (formaction ?/delete) deletes that row */
	const submit: SubmitFunction = (input) => {
		if (busy) { input.cancel(); return; }
		return input.action.search.includes('delete') ? remove(String(input.formData.get('rowId') ?? '')) : add(input);
	};
	function discard(e: MouseEvent) {
		e.preventDefault();
		fields = blank();
		addError = null;
	}
	// leaving the page drops the form: ask first when it holds an unsaved or failed entry, or a save is in flight (a
	// reload or close gets the browser's own prompt)
	let leaving = false;
	beforeNavigate((nav) => {
		if (leaving || !unsaved) return;
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		const url = nav.to.url;
		ask = { what: sending ? 'A payment is still being saved; leaving now may not show whether it was saved. Leave anyway?' : addError ? 'The payment in the form was not saved. Leave and discard it?' : 'The payment in the form is not saved yet. Leave and discard it?', go: () => { leaving = true; void goto(url).finally(() => { leaving = false; }); } };
	});
	function answer(yes: boolean) {
		const a = ask;
		ask = null;
		if (yes && a) a.go();
	}
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
		<form method="POST" action="?/add" use:enhance={submit} id="pay-form" aria-busy={busy}>
			<div class="q-row">
				<div><label for="pay_date">Date</label><input id="pay_date" name="date" type="date" bind:value={fields.date} aria-invalid={addError?.field === 'date' ? 'true' : undefined} aria-describedby={addError ? 'pay-error' : undefined} /><small class="q-hint">optional; a year from 1000 to 9999</small></div>
				<div><label for="pay_amount">Amount (R)</label><input id="pay_amount" name="amount" type="text" inputmode="decimal" autocomplete="off" bind:value={fields.amount} aria-invalid={addError?.field === 'amount' ? 'true' : undefined} aria-describedby="pay_amount_hint{addError ? ' pay-error' : ''}" /><small class="q-hint" id="pay_amount_hint">up to 13 digits of rand and 2 decimals</small></div>
				<div><label for="pay_method">Method / reference</label><input id="pay_method" name="method" type="text" bind:value={fields.method} aria-invalid={addError?.field === 'method' ? 'true' : undefined} /><small class="q-hint">at most {MAX_LENGTH.method} characters</small></div>
				<div class="q-grow2"><label for="pay_note">Note</label><input id="pay_note" name="note" type="text" bind:value={fields.note} aria-invalid={addError?.field === 'note' ? 'true' : undefined} /><small class="q-hint">at most {MAX_LENGTH.note.toLocaleString('en').replace(',', ' ')} characters</small></div>
				<div class="q-tight"><button id="pay-add" disabled={busy}>Add</button></div>
			</div>
		</form>
		{#if busy}<p class="q-status" role="status" id="pay-status">{sending ? 'Saving the payment… the form stays editable; the result applies to what was sent.' : 'Deleting the payment…'}</p>{/if}
		{#if addError}
			<div class="error q-actions" role="alert" id="pay-error">
				<span>{addError.message}</span>
				{#if addError.retry}<button type="submit" form="pay-form" id="pay-retry" disabled={busy}>Retry</button>{/if}
				<a href={page.url.pathname} id="pay-discard" onclick={discard}>Discard the entry</a>
			</div>
		{/if}
		{#if goneNotice}<div class="q-flag q-actions" role="alert" id="pay-delete-notice"><span>{goneNotice}</span><button type="button" onclick={() => (goneNotice = null)}>Dismiss</button></div>{/if}
		{#if ask}
			<div class="q-flag q-actions" role="alertdialog" aria-labelledby="pay-ask-text" id="pay-ask">
				<span id="pay-ask-text">{ask.what}</span>
				<button type="button" id="pay-ask-leave" onclick={() => answer(true)}>Leave and discard it</button>
				<button type="button" id="pay-ask-stay" onclick={() => answer(false)}>Stay</button>
			</div>
		{/if}
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
							<!-- Delete submits the Add form (formaction ?/delete), so the typed entry travels with it and comes back
							     without JavaScript; the row's stored-fields hash travels too (the changed-elsewhere check) -->
							<td class="q-nowrap"><input type="hidden" form="pay-form" name="hash.{p.rowId}" value={p.hash} /><button form="pay-form" formaction="?/delete" name="rowId" value={p.rowId} disabled={busy} data-delete>Delete</button><form method="POST" action="?/delete" hidden><input type="hidden" name="rowId" value={p.rowId} /><input type="hidden" name="hash" value={p.hash} /></form>
								{#if deleteErrors[p.rowId]}<p class="error" role="alert" data-delete-error={p.rowId}>{deleteErrors[p.rowId]}</p>{/if}</td>
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
