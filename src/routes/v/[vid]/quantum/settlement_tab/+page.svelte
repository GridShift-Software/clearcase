<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { fmtR } from '$lib/components/format';
	import { centsText } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { defaultInputs, settleInputs, settleOutcome } from '$lib/views/quantum/settlement';
	import '$lib/views/quantum/quantum.css';
	let { data } = $props();
	// BA-03: the inputs are the URL query; Model submits them (GET), so a reload gives the same result. Without a
	// query the model runs on the defaults, as v5 does on render.
	const defaults = $derived(defaultInputs(data.claim, data.defaults));
	const inputs = $derived(settleInputs(page.url.searchParams, defaults));
	const out = $derived(settleOutcome(inputs));
	const missing = $derived(([['probability', 'Probability of full recovery'], ['years', 'Years to recover'], ['discount', 'Discount rate'], ['cost', 'Enforcement cost']] as const).filter(([k]) => data.defaults[k] === null).map(([, l]) => l));
	const R = (c: string) => fmtR(centsText(BigInt(c)));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="settlement_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Settlement / BATNA" section="Settlement / BATNA" caseName={data.version.titleName} subtitle={data.subtitle} />
	{#if data.narrative}<div class="q-card"><Narrative text={data.narrative} resultsVersion={data.version.id} known={[]} /></div>{/if}
	<div class="q-card">
		<form method="GET" id="se-form" data-sveltekit-replacestate data-sveltekit-noscroll data-sveltekit-keepfocus>
			<div class="q-row">
				<div><label for="se_claim">Claim value (R)</label><input id="se_claim" name="claim" value={inputs.claim} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.claim ? 'true' : undefined} /></div>
				<div><label for="se_p">Probability of full recovery (%)</label><input id="se_p" name="p" value={inputs.p} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.p ? 'true' : undefined} /></div>
				<div><label for="se_y">Years to recover</label><input id="se_y" name="y" value={inputs.y} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.y ? 'true' : undefined} /></div>
				<div><label for="se_d">Discount rate (% p.a.)</label><input id="se_d" name="d" value={inputs.d} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.d ? 'true' : undefined} /></div>
				<div><label for="se_c">Enforcement cost (R)</label><input id="se_c" name="c" value={inputs.c} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.c ? 'true' : undefined} /></div>
				<div class="q-tight"><button id="se-model">Model</button></div>
				<div class="q-tight"><a href={page.url.pathname} id="se-reset" data-sveltekit-replacestate data-sveltekit-noscroll>Reset to defaults</a></div>
			</div>
		</form>
		{#if data.payments.count}<p class="q-note" id="se-net">The claim value is prefilled net of {data.payments.counted} recorded {data.payments.counted === 1 ? 'payment' : 'payments'} ({R(data.payments.paid)}) on Payments &amp; Net Claim; the gross amount due is {R(data.payments.gross)} as at {data.payments.claimDate}.</p>{/if}
		{#if missing.length}<p class="q-note" id="se-missing">This package gives no default for {missing.join(', ')}: enter your assessment.</p>{/if}
		<div id="se_out">
			{#if out.kpis}
				<div class="q-kpis">{#each out.kpis as k (k.label)}<Kpi label={k.label} value={k.value} />{/each}</div>
				<div class="q-floor"><b>Indicative settlement floor:</b> {out.floor}</div>
				<p class="tag">Illustrative model, not advice — the probability and horizon are counsel's call, informed by the enforcement and legality tabs.</p>
			{:else}
				<div class="error" role="alert" id="se-error"><ul>{#each Object.values(out.errors) as e (e)}<li>{e}</li>{/each}</ul></div>
			{/if}
		</div>
	</div>
</main>

<style>
	.q-floor { background: #f5f7fa; border: 1px solid #ddd; border-radius: 6px; padding: .6rem .8rem; margin-top: .8rem; }
</style>
