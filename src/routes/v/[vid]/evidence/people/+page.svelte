<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { anyRole, looksAutomated } from '$lib/views/evidence/people';
	let { data } = $props();
	const ps = $derived(data.people ?? []);
	// the Role column carries information only when the package supplies a role for someone (v5 never shows it)
	const showRole = $derived(anyRole(ps));
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'people' : null}>
	<PageHeader heading="People" section="People" caseName={data.version.titleName} subtitle="{ps.length} correspondents & signatories from email headers" />
	<p class="disclosure" id="identity-status" data-verification="unverified">Names, organisations and roles are inferred from e-mail headers and have not been checked; no professional identity shown here is confirmed.</p>
	{#if !data.people}<p class="warning">This results package has no people dataset.</p>{/if}
	<div class="card pad0">
		<table class="tbl" id="people-table">
			<thead><tr><th>Name</th><th>Email</th><th>Organisation</th>{#if showRole}<th>Role (inferred, unverified)</th>{/if}<th class="num">Sent</th><th class="num">Received</th><th class="num">Total</th></tr></thead>
			<tbody>
				{#each ps as x, i (i)}
					<tr data-automated={looksAutomated(x.email) ? 'true' : null}>
						<td>{x.name}</td>
						<td class="mono"><span class="addr">{x.email}</span>{#if looksAutomated(x.email)}<small class="hint">automated address</small>{/if}</td>
						<td>{x.org || '—'}</td>
						{#if showRole}<td>{x.role}</td>{/if}
						<td class="num">{x.sent}</td><td class="num">{x.received}</td><td class="num">{x.total}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</main>

<style>
	.mono { font-family: ui-monospace, monospace; }
	.hint { display: block; color: #6a4b00; font-family: system-ui, sans-serif; }
	.disclosure { color: #6a4b00; }
</style>
