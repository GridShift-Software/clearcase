<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	let { data, form } = $props();
</script>

<main id="main" tabindex="-1" data-ready="recovery">
	<PageHeader heading="Startup checks" section="Startup checks" />
	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	{#if data.recovery}
		<p class="error">Active version <code>{data.recovery.configured}</code> failed verification: {data.recovery.reason}. Shown instead: <code>{data.recovery.effective ?? 'none'}</code>.</p>
	{:else}
		<p class="ok">All active versions verified.</p>
	{/if}
	{#if data.startup}
		<p>Checked at {data.startup.at} in {data.startup.ms} ms. Leftover temporary files removed: {data.startup.cleaned.length}. Candidates removed by retention: {data.startup.pruned.length}.</p>
		<table><thead><tr><th>Version</th><th>Result</th><th class="num">ms</th></tr></thead><tbody>
			{#each data.startup.checked as c (c.vid)}<tr><td><code>{c.vid}</code></td><td class={c.ok ? 'ok' : 'unresolved'}>{c.ok ? 'verified' : c.reason}</td><td class="num">{c.ms}</td></tr>{/each}
		</tbody></table>
	{/if}
</main>
