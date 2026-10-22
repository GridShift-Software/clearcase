<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { METHODS } from '$lib/calculations/interest';
	import { importedUnits } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { defaultInputs, INTEREST_FIELDS, MAX_RATE, queryInputs, shownOutcome, type InterestInputs } from '$lib/views/quantum/interest';
	import '$lib/views/quantum/quantum.css';
	let { data } = $props();
	const submitted = $derived(queryInputs(new URLSearchParams(page.url.search), data.defaults));
	const inputs = $derived(submitted ?? defaultInputs(data.defaults));
	const out = $derived(submitted ? shownOutcome(submitted, { units: importedUnits(data.headlineDue), date: data.headlineDate, paymentDates: data.paymentDates }) : null);
	const errs = $derived(out?.errors ?? {});
	let vals = $state<InterestInputs>({ ...untrack(() => inputs) });
	let sent: InterestInputs | null = null;
	afterNavigate(() => {
		const next = inputs;
		if (sent) { const s = sent; for (const k of INTEREST_FIELDS) if (vals[k] === s[k]) vals[k] = next[k]; }
		else vals = { ...next };
		sent = null;
	});
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="interest_calc_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Interest Recalculator" section="Interest Recalculator" caseName={data.version.titleName} subtitle="Reproduce and stress-test the interest underlying the claim" />
	{#if data.note}
		<div class="q-card">
			<Narrative text={data.note} resultsVersion={data.version.id} known={data.known} />
			<p class="q-note" id="note-imported">Imported narrative: not checked against the dates or figures computed here.</p>
		</div>
	{/if}
	<div class="q-card">
		<form method="GET" id="ic-form" data-sveltekit-replacestate data-sveltekit-noscroll data-sveltekit-keepfocus onsubmit={() => { sent = { ...vals }; }}>
			<div class="q-row">
				<div><label for="ic_p">Capital outstanding (R)</label><input id="ic_p" name="p" bind:value={vals.p} placeholder="e.g. from latest statement" inputmode="decimal" autocomplete="off" aria-invalid={errs.p ? 'true' : undefined} /><small class="q-hint">up to 13 digits of rand and 2 decimals</small></div>
				<div><label for="ic_r">Rate (% per annum)</label><input id="ic_r" name="r" bind:value={vals.r} inputmode="decimal" autocomplete="off" aria-invalid={errs.r ? 'true' : undefined} /><small class="q-hint">0 to {MAX_RATE}</small></div>
				<div><label for="ic_m">Method</label><select id="ic_m" name="m" bind:value={vals.m} aria-invalid={errs.m ? 'true' : undefined}>{#each METHODS as m (m)}<option value={m}>{m}</option>{/each}</select></div>
				<div><label for="ic_from">From (mora)</label><input id="ic_from" name="from" type="date" bind:value={vals.from} aria-invalid={errs.from ? 'true' : undefined} /><small class="q-hint">a year from 1000 to 9999</small></div>
				<div><label for="ic_to">To</label><input id="ic_to" name="to" type="date" bind:value={vals.to} aria-invalid={errs.to ? 'true' : undefined} /></div>
				<div class="q-tight"><button id="ic-compute">Compute</button></div>
				<div class="q-tight"><a href={page.url.pathname} id="ic-reset" data-sveltekit-replacestate data-sveltekit-noscroll onclick={() => { sent = null; vals = { ...defaultInputs(data.defaults) }; }}>Reset to defaults</a></div>
			</div>
		</form>
		{#if data.defaults.rate === null}<p class="q-note" id="rate-missing">This package gives no default rate: enter the rate fixed by the award or contract.</p>{/if}
		<div id="ic_out">
			{#if out}
				{#if Object.keys(errs).length}
					<div class="error" role="alert" id="ic-error"><ul>{#each Object.values(errs) as e (e)}<li>{e}</li>{/each}</ul></div>
				{:else if out.kpis}
					<div class="q-kpis">{#each out.kpis as k (k.label)}<Kpi label={k.label} value={k.value} sub={k.sub} />{/each}</div>
					{#if out.comparison}<div class="q-note" id="ic-compare"><p id="ic-compare-verdict">{out.comparison.verdict}</p><p id="ic-basis-total">{out.comparison.total}</p><p id="ic-basis-due">{out.comparison.due}</p></div>{/if}
					<p class="tag">Simple vs compound and the from-date materially change the number — this is the exposure counsel must be able to defend. Replace the rate with the rate fixed by the award/contract.</p>
					<p class="q-note" id="ic-basis">Day count: calendar days between the dates (counted on the calendar, independent of any time zone) over 365.25 days a year; simple interest is exact, compound interest uses the monthly formula; each figure is rounded once to the cent.</p>
				{/if}
			{/if}
		</div>
	</div>
</main>
