<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { METHODS } from '$lib/calculations/interest';
	import { importedUnits } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { defaultInputs, interestOutcome, queryInputs } from '$lib/views/quantum/interest';
	import '$lib/views/quantum/quantum.css';
	let { data } = $props();
	// BA-03: the inputs are the URL query; Compute submits them (GET), so a reload gives the same result
	const submitted = $derived(queryInputs(page.url.searchParams, data.defaults));
	const inputs = $derived(submitted ?? defaultInputs(data.defaults));
	const out = $derived(submitted ? interestOutcome(submitted, importedUnits(data.headlineDue)) : null);
	const errs = $derived(out?.errors ?? {});
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
		<form method="GET" id="ic-form" data-sveltekit-replacestate data-sveltekit-noscroll data-sveltekit-keepfocus>
			<div class="q-row">
				<div><label for="ic_p">Capital outstanding (R)</label><input id="ic_p" name="p" value={inputs.p} placeholder="e.g. from latest statement" inputmode="decimal" autocomplete="off" aria-invalid={errs.p ? 'true' : undefined} /></div>
				<div><label for="ic_r">Rate (% per annum)</label><input id="ic_r" name="r" value={inputs.r} inputmode="decimal" autocomplete="off" aria-invalid={errs.r ? 'true' : undefined} /></div>
				<div><label for="ic_m">Method</label><select id="ic_m" name="m" value={inputs.m}>{#each METHODS as m (m)}<option value={m}>{m}</option>{/each}</select></div>
				<div><label for="ic_from">From (mora)</label><input id="ic_from" name="from" type="date" value={inputs.from} aria-invalid={errs.from ? 'true' : undefined} /></div>
				<div><label for="ic_to">To</label><input id="ic_to" name="to" type="date" value={inputs.to} aria-invalid={errs.to ? 'true' : undefined} /></div>
				<div class="q-tight"><button id="ic-compute">Compute</button></div>
				<div class="q-tight"><a href={page.url.pathname} id="ic-reset" data-sveltekit-replacestate data-sveltekit-noscroll>Reset to defaults</a></div>
			</div>
		</form>
		{#if data.defaults.rate === null}<p class="q-note" id="rate-missing">This package gives no default rate: enter the rate fixed by the award or contract.</p>{/if}
		<div id="ic_out">
			{#if out}
				{#if Object.keys(errs).length}
					<div class="error" role="alert" id="ic-error"><ul>{#each Object.values(errs) as e (e)}<li>{e}</li>{/each}</ul></div>
				{:else if out.kpis}
					<div class="q-kpis">{#each out.kpis as k (k.label)}<Kpi label={k.label} value={k.value} sub={k.sub} />{/each}</div>
					<p class="tag">Simple vs compound and the from-date materially change the number — this is the exposure counsel must be able to defend. Replace the rate with the rate fixed by the award/contract.</p>
					<p class="q-note" id="ic-basis">Day count: calendar days between the dates (counted in UTC) over 365.25 days a year; simple interest is exact, compound interest uses the monthly formula; each figure is rounded once to the cent.</p>
				{/if}
			{/if}
		</div>
	</div>
</main>
