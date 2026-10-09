<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { infoTone } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	let { data, form } = $props();
	// The operator's choice for an item until the server has saved it; a failed save keeps it (and the error) so the
	// checkbox still shows what was chosen and Retry sends it again. Without JavaScript the action's failure carries it.
	let choice = $state<Record<string, boolean>>({});
	let failed = $state<{ key: string; done: boolean; message: string } | null>(null);
	const noJsFailure = $derived(form && 'key' in form && 'message' in form ? { key: String(form.key), done: form.done === true, message: String(form.message) } : null);
	const problem = $derived(failed ?? noJsFailure);
	const shown = (r: { key: string; done: boolean }) => choice[r.key] ?? (noJsFailure?.key === r.key ? noJsFailure.done : r.done);
	const submit: SubmitFunction = ({ formData }) => {
		const key = String(formData.get('key'));
		const done = formData.get('done') === 'true';
		choice[key] = done;
		failed = null;
		return async ({ result, update }) => {
			if (result.type === 'success') { await update({ reset: false }); delete choice[key]; }
			else if (result.type === 'failure') failed = { key, done, message: String(result.data?.message ?? 'Not saved.') };
			else if (result.type === 'error') failed = { key, done, message: 'Not saved: ClearCase could not be reached. Your choice is kept; retry when it is running.' };
			else await update();
		};
	};
	const itemOf = (key: string) => data.rows.find((r) => r.key === key)?.item ?? '';
	let hydrated = $state(false);
	onMount(() => { hydrated = true; });
</script>

<main id="main" tabindex="-1" data-analysis data-ready="info_required_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Info Required" section="Info Required" caseName={data.version.titleName} subtitle="Checklist of outstanding items" />
	{#if problem}
		<div class="an-error" role="alert" id="info-error">
			<span>{problem.message} ({problem.done ? 'done' : 'not done'}: {itemOf(problem.key)})</span>
			<form method="POST" action="?/toggle" use:enhance={submit} class="no-print" style="display:inline">
				<input type="hidden" name="key" value={problem.key} />
				<input type="hidden" name="done" value={String(problem.done)} />
				<button id="info-retry">Retry</button>
			</form>
		</div>
	{/if}
	{#if data.rows.length === 0}
		<div class="an-card"><div class="an-empty" id="info-empty">No information-required items in this results version.</div></div>
	{:else}
		<div class="an-card pad0"><div class="an-scroll">
			<table class="an-table an-stack" id="info-table">
				<thead><tr><th aria-label="Done"></th><th>Item</th><th>Status</th><th>Owner</th></tr></thead>
				<tbody>
					{#each data.rows as r (r.key)}
						<tr data-key={r.key} aria-busy={r.key in choice && failed?.key !== r.key ? 'true' : null}>
							<td>
								<form method="POST" action="?/toggle" use:enhance={submit}>
									<input type="hidden" name="key" value={r.key} />
									<input type="checkbox" name="done" value="true" aria-label="Done: {r.item}" checked={shown(r)}
										onchange={(e) => e.currentTarget.form?.requestSubmit()} />
									<noscript><button>Save</button></noscript>
								</form>
							</td>
							<td data-label="Item" class:struck={shown(r)}>{r.item}</td>
							<td data-label="Status"><span class="badge {infoTone(r.status)}">{r.status}</span></td>
							<td data-label="Owner">{r.owner}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div></div>
		{#if data.detached}<p class="an-tag" id="info-detached">{data.detached} saved {data.detached === 1 ? 'check belongs' : 'checks belong'} to items that are not in this results version; they are kept.</p>{/if}
	{/if}
</main>

<style>
	.struck { text-decoration: line-through; color: #888; }
</style>
