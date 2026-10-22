<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { fmtR } from '$lib/components/format';
	import { centsText } from '$lib/calculations/money';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { defaultInputs, MAX_DISCOUNT, MAX_PROBABILITY, MAX_YEARS, SETTLE_FIELDS, settleInputs, settleOutcome, type SettleInputs } from '$lib/views/quantum/settlement';
	import '$lib/views/quantum/quantum.css';
	let { data } = $props();
	const defaults = $derived(defaultInputs(data.claim, data.defaults));
	const inputs = $derived(settleInputs(new URLSearchParams(page.url.search), defaults));
	const out = $derived(settleOutcome(inputs));
	let vals = $state<SettleInputs>({ ...untrack(() => inputs) });
	let sent: SettleInputs | null = null;
	afterNavigate(() => {
		const next = inputs;
		if (sent) { const s = sent; for (const k of SETTLE_FIELDS) if (vals[k] === s[k]) vals[k] = next[k]; }
		else vals = { ...next };
		sent = null;
	});
	const missing = $derived(([['probability', 'Probability of full recovery'], ['years', 'Years to recover'], ['discount', 'Discount rate'], ['cost', 'Enforcement cost']] as const).filter(([k]) => data.defaults[k] === null).map(([, l]) => l));
	const R = (c: string) => fmtR(centsText(BigInt(c)));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="settlement_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Settlement / BATNA" section="Settlement / BATNA" caseName={data.version.titleName} subtitle={data.subtitle} />
	{#if data.narrative}<div class="q-card"><Narrative text={data.narrative} resultsVersion={data.version.id} known={[]} /></div>{/if}
	<div class="q-card">
		<form method="GET" id="se-form" data-sveltekit-replacestate data-sveltekit-noscroll data-sveltekit-keepfocus onsubmit={() => { sent = { ...vals }; }}>
			<div class="q-row">
				<div><label for="se_claim">Claim value (R)</label><input id="se_claim" name="claim" bind:value={vals.claim} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.claim ? 'true' : undefined} /><small class="q-hint">up to 13 digits of rand and 2 decimals; may be negative</small></div>
				<div><label for="se_p">Probability of full recovery (%)</label><input id="se_p" name="p" bind:value={vals.p} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.p ? 'true' : undefined} /><small class="q-hint">0 to {MAX_PROBABILITY}</small></div>
				<div><label for="se_y">Years to recover</label><input id="se_y" name="y" bind:value={vals.y} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.y ? 'true' : undefined} /><small class="q-hint">0 to {MAX_YEARS}</small></div>
				<div><label for="se_d">Discount rate (% p.a.)</label><input id="se_d" name="d" bind:value={vals.d} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.d ? 'true' : undefined} /><small class="q-hint">0 to {MAX_DISCOUNT}</small></div>
				<div><label for="se_c">Enforcement cost (undiscounted, R)</label><input id="se_c" name="c" bind:value={vals.c} inputmode="decimal" autocomplete="off" aria-invalid={out.errors.c ? 'true' : undefined} /><small class="q-hint">up to 13 digits of rand and 2 decimals</small></div>
				<div class="q-tight"><button id="se-model">Model</button></div>
				<div class="q-tight"><a href={page.url.pathname} id="se-reset" data-sveltekit-replacestate data-sveltekit-noscroll onclick={() => { sent = null; vals = { ...defaults }; }}>Reset to defaults</a></div>
			</div>
		</form>
		{#if data.payments.count}<p class="q-note" id="se-net">The claim value is prefilled net of {data.payments.counted} recorded {data.payments.counted === 1 ? 'payment' : 'payments'} ({R(data.payments.paid)}) on Payments &amp; Net Claim; the gross amount due is {R(data.payments.gross)} as at {data.payments.claimDate}.{#if data.payments.excess !== null}{' '}The recorded payments exceed the gross amount due by {R(data.payments.excess)}, so the prefilled net claim is negative; the model is computed on it as v5 computes a negative claim.{/if}</p>{/if}
		{#if missing.length}<p class="q-note" id="se-missing">This package gives no default for {missing.join(', ')}: enter your assessment.</p>{/if}
		<div id="se_out">
			{#if out.kpis}
				<div class="q-kpis">{#each out.kpis as k (k.label)}<Kpi label={k.label} value={k.value} sub={k.sub} />{/each}</div>
				<div class="q-floor"><b>Indicative settlement floor:</b> {out.floor}</div>
				<p class="tag">Illustrative model, not advice — the probability and horizon are counsel's call, informed by the enforcement and legality tabs.</p>
			{:else}
				<div class="error" role="alert" id="se-error"><ul>{#each Object.values(out.errors) as e (e)}<li>{e}</li>{/each}</ul></div>
			{/if}
		</div>
	</div>
</main>
