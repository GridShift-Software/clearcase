<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { infoTone } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	let { data, form } = $props();
	// Every unsaved choice, per item key, until the server has saved that key: in flight, or failed with its message.
	// A failed key keeps its choice, its error and its Retry until that key saves; a save of another key never clears
	// it. At most one save per key is in flight: a later choice waits in `queued` and goes out when the first settles,
	// so the stored value is the last choice. Without JavaScript the action carries the failures back (`pending`), and
	// every form posts those still shown.
	type Failure = { key: string; done: boolean; message: string };
	let choice = $state<Record<string, boolean>>({});
	let failures = $state<Record<string, { done: boolean; message: string }>>({});
	const inflight: Record<string, true> = {};
	const queued: Record<string, boolean> = {};
	let hydrated = $state(false);
	const noJs = $derived<Failure[]>(hydrated || !form ? [] : [
		...('key' in form && 'message' in form ? [{ key: String(form.key), done: form.done === true, message: String(form.message) }] : []),
		...('pending' in form && Array.isArray(form.pending) ? (form.pending as Failure[]) : []),
	].filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i));
	const order = (key: string) => data.rows.findIndex((r) => r.key === key);
	// listed in the table's order
	const problems = $derived<Failure[]>([
		...Object.entries(failures).map(([key, f]) => ({ key, ...f })),
		...noJs.filter((f) => !(f.key in failures) && !(f.key in choice)),
	].sort((a, b) => order(a.key) - order(b.key)));
	const shown = (r: { key: string; done: boolean }) => choice[r.key] ?? noJs.find((f) => f.key === r.key)?.done ?? r.done;
	const busy = (key: string) => key in choice && !(key in failures);
	const unsaved = (key: string) => key in failures || (!(key in choice) && noJs.some((f) => f.key === key));
	// send a queued choice through the row's own form, as a tick does
	const flush = (key: string, done: boolean) => {
		const form = document.querySelector<HTMLFormElement>(`tr[data-key="${CSS.escape(key)}"] form`);
		const box = form?.querySelector<HTMLInputElement>('input[type=checkbox]');
		if (form && box) { box.checked = done; form.requestSubmit(); }
	};
	const submit: SubmitFunction = ({ formData, cancel }) => {
		const key = String(formData.get('key'));
		const done = formData.get('done') === 'true';
		choice[key] = done;
		delete failures[key];
		if (key in inflight) { queued[key] = done; cancel(); return; }
		inflight[key] = true;
		return async ({ result, update }) => {
			if (result.type === 'success') await update({ reset: false });
			else if (result.type === 'failure') failures[key] = { done, message: String(result.data?.message ?? 'Not saved.') };
			else if (result.type === 'error') failures[key] = { done, message: result.status ? `Not saved: ClearCase answered ${result.status}. Your choice is kept; retry.` : 'Not saved: ClearCase could not be reached. Your choice is kept; retry when it is running.' };
			else await update();
			const next = queued[key];
			delete queued[key];
			delete inflight[key];
			if (next !== undefined && next !== done) flush(key, next);
			else if (result.type === 'success') delete choice[key];
		};
	};
	const itemOf = (key: string) => data.rows.find((r) => r.key === key)?.item ?? '';
	onMount(() => {
		// failures the action answered before hydration become tracked failures, so a later save of another item keeps them
		for (const f of noJs) { choice[f.key] = f.done; failures[f.key] = { done: f.done, message: f.message }; }
		hydrated = true;
	});
</script>

<main id="main" tabindex="-1" data-analysis data-ready="info_required_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading="Info Required" section="Info Required" caseName={data.version.titleName} subtitle="Checklist of outstanding items" />
	{#if problems.length}
		<div class="an-error" role="alert" id="info-error">
			{#each problems as pr (pr.key)}
				<div class="info-problem" data-key={pr.key}>
					<span>{pr.message} ({pr.done ? 'done' : 'not done'}: {itemOf(pr.key)})</span>
					<form method="POST" action="?/toggle" use:enhance={submit} class="no-print retry">
						<input type="hidden" name="key" value={pr.key} />
						<input type="hidden" name="done" value={String(pr.done)} />
						{#if !hydrated}{#each problems as f (f.key)}<input type="hidden" name="pending" value={JSON.stringify(f)} />{/each}{/if}
						<button class="info-retry" aria-label="Retry: {itemOf(pr.key)}">Retry</button>
					</form>
				</div>
			{/each}
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
						<tr data-key={r.key} aria-busy={busy(r.key) ? 'true' : null} class:saving={busy(r.key)}>
							<td>
								<form method="POST" action="?/toggle" use:enhance={submit}>
									<input type="hidden" name="key" value={r.key} />
									{#if !hydrated}{#each problems as f (f.key)}<input type="hidden" name="pending" value={JSON.stringify(f)} />{/each}{/if}
									<input type="checkbox" name="done" value="true" aria-label="Done: {r.item}" checked={shown(r)}
										onchange={(e) => e.currentTarget.form?.requestSubmit()} />
									<noscript><button>Save</button></noscript>
								</form>
							</td>
							<td data-label="Item" class:struck={shown(r)}>{r.item}{#if busy(r.key)}<span class="row-state" data-state="saving">Saving…</span>{:else if unsaved(r.key)}<span class="row-state an-danger" data-state="unsaved">Not saved</span>{/if}</td>
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
	.retry { display: inline; margin-left: .5rem; }
	.info-problem + .info-problem { margin-top: .3rem; }
	.saving { opacity: .7; }
	.row-state { display: inline-block; margin-left: .5rem; font-size: .85em; font-weight: 600; color: #333; }
	.row-state.an-danger { color: #a01010; }
</style>
