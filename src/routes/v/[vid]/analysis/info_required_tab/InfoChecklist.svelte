<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { infoTone } from '$lib/views/analysis/tone';
	import '$lib/views/analysis/analysis.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	// The hosted route names the version each tick rests on (`none` for an item never ticked), so a stale page cannot overwrite
	// newer work, and each tick carries an operation id that a retry of the same tick keeps. The local route sends neither.
	const versions = $derived((data as { versions?: Record<string, string> }).versions);
	const opIds: Record<string, string> = {};
	const opFor = (key: string, done: boolean) => (opIds[`${key}:${done}:${versions?.[key] ?? ''}`] ??= crypto.randomUUID());
	type Failure = { key: string; done: boolean; message: string };
	let choice = $state<Record<string, boolean>>({});
	let failures = $state<Record<string, { done: boolean; message: string }>>({});
	const inflight: Record<string, true> = {};
	const queued: Record<string, boolean> = {};
	const rowForms = new Map<string, HTMLFormElement>();
	const own = (node: HTMLFormElement, key: string) => {
		rowForms.set(key, node);
		return { destroy() { if (rowForms.get(key) === node) rowForms.delete(key); } };
	};
	let alive = true;
	onDestroy(() => { alive = false; });
	let hydrated = $state(false);
	const noJs = $derived<Failure[]>(hydrated || !form ? [] : [
		...('key' in form && 'message' in form ? [{ key: String(form.key), done: form.done === true, message: String(form.message) }] : []),
		...('pending' in form && Array.isArray(form.pending) ? (form.pending as Failure[]) : []),
	].filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i));
	const order = (key: string) => data.rows.findIndex((r) => r.key === key);
	const problems = $derived<Failure[]>([
		...Object.entries(failures).map(([key, f]) => ({ key, ...f })),
		...noJs.filter((f) => !(f.key in failures) && !(f.key in choice)),
	].sort((a, b) => order(a.key) - order(b.key)));
	const shown = (r: { key: string; done: boolean }) => choice[r.key] ?? noJs.find((f) => f.key === r.key)?.done ?? r.done;
	const busy = (key: string) => key in choice && !(key in failures);
	const unsaved = (key: string) => key in failures || (!(key in choice) && noJs.some((f) => f.key === key));
	const flush = (key: string, done: boolean) => {
		const form = rowForms.get(key);
		const box = form?.querySelector<HTMLInputElement>('input[type=checkbox]');
		if (!form || !box) return false;
		box.checked = done;
		form.requestSubmit();
		return true;
	};
	const sendToOwnCase = (action: URL, key: string, done: boolean) => {
		const body = new FormData();
		body.set('key', key);
		if (done) body.set('done', 'true');
		if (versions) { body.set('version', versions[key] ?? 'none'); body.set('operationId', opFor(key, done)); }
		return fetch(action, { method: 'POST', body, headers: { accept: 'application/json', 'x-sveltekit-action': 'true' } }).catch(() => {});
	};
	const submit: SubmitFunction = ({ formData, action, cancel }) => {
		const key = String(formData.get('key'));
		const done = formData.get('done') === 'true';
		if (versions) { formData.set('version', versions[key] ?? 'none'); formData.set('operationId', opFor(key, done)); }
		choice[key] = done;
		delete failures[key];
		if (key in inflight) { queued[key] = done; cancel(); return; }
		inflight[key] = true;
		return async ({ result, update }) => {
			// once the operator has left, the answer has no page to show it on, and `update` would act on the new page
			if (alive) {
				if (result.type === 'success') { delete opIds[`${key}:${done}:${versions?.[key] ?? ''}`]; await update({ reset: false }); }
				else if (result.type === 'failure') failures[key] = { done, message: String(result.data?.message ?? 'Not saved.') };
				else if (result.type === 'error') failures[key] = { done, message: result.status ? `Not saved: ClearCase answered ${result.status}. Your choice is kept; retry.` : 'Not saved: ClearCase could not be reached. Your choice is kept; retry when it is running.' };
				else await update();
			}
			const next = queued[key];
			delete queued[key];
			delete inflight[key];
			if (next !== undefined && next !== done) { if (!(alive && flush(key, next))) await sendToOwnCase(action, key, next); }
			else if (alive && result.type === 'success') delete choice[key];
		};
	};
	const itemOf = (key: string) => data.rows.find((r) => r.key === key)?.item ?? '';
	onMount(() => {
		for (const f of noJs) { choice[f.key] = f.done; failures[f.key] = { done: f.done, message: f.message }; }
		hydrated = true;
	});
</script>

<main id="main" tabindex="-1" data-analysis data-ready="info_required_tab" data-hydrated={hydrated ? '' : null}>
	<PageHeader heading={data.heading} section="Info Required" caseName={data.version.titleName} subtitle="Checklist of outstanding items" />
	{#if problems.length}
		<div class="an-error" role="alert" id="info-error">
			{#each problems as pr (pr.key)}
				<div class="info-problem" data-key={pr.key}>
					<span>{pr.message} ({pr.done ? 'done' : 'not done'}: {itemOf(pr.key)})</span>
					<form method="POST" action="?/toggle" use:enhance={submit} class="no-print retry">
						<input type="hidden" name="key" value={pr.key} />
						<input type="hidden" name="done" value={String(pr.done)} />
						{#if versions}<input type="hidden" name="version" value={versions[pr.key] ?? 'none'} />{/if}
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
		<div class="an-card pad0"><TableScroll label="Information required" class="an-scroll">
			<table class="an-table an-stack" id="info-table">
				<thead><tr><th aria-label="Done"></th><th>Item</th><th>Status</th><th>Owner</th></tr></thead>
				<tbody>
					{#each data.rows as r (r.key)}
						<tr data-key={r.key} aria-busy={busy(r.key) ? 'true' : null} class:saving={busy(r.key)}>
							<td>
								<form method="POST" action="?/toggle" use:enhance={submit} use:own={r.key}>
									<input type="hidden" name="key" value={r.key} />
									{#if versions}<input type="hidden" name="version" value={versions[r.key] ?? 'none'} />{/if}
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
		</TableScroll></div>
		{#if data.detached}<p class="an-tag" id="info-detached">{data.detached} saved {data.detached === 1 ? 'check belongs' : 'checks belong'} to items that are not in this results version; they are kept.</p>{/if}
	{/if}
</main>

<style>
	.struck { text-decoration: line-through; color: var(--ink-3); }
	.retry { display: inline; margin-left: .5rem; }
	.info-problem + .info-problem { margin-top: .3rem; }
	.saving { opacity: .7; }
	.row-state { display: inline-block; margin-left: .5rem; font-size: .85em; font-weight: 600; color: var(--ink-2); }
	.row-state.an-danger { color: var(--danger); }
</style>
