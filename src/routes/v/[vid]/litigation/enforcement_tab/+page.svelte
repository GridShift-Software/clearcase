<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { shownStatus, statusOptions } from '$lib/views/litigation/enforcement';
	import { ANALYSIS_NOTE } from '$lib/views/litigation/notes';
	import { LOST, failureMessage } from '$lib/views/litigation/submit';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	// Each step's own save state: the value the user chose (kept when its save fails, until it is saved), its error and
	// whether it saved. A save never resets the form (a reset would put the select back on its server-rendered option).
	let steps = $state<Record<string, { value: string; error: string | null; saved: boolean }>>({});
	// without JavaScript, the server-rendered failure names its step and value
	const failed = $derived(form && 'values' in form && form.values ? (form.values as { stepKey: string; status: string }) : null);
	const valueOf = (r: (typeof data.rows)[number]) => (r.key && steps[r.key]?.value) || (r.key && failed?.stepKey === r.key ? failed.status : null) || shownStatus(r);
	const errorOf = (key: string) => (key in steps ? steps[key]!.error : failed?.stepKey === key && form && 'message' in form ? (form.message as string) : null);
	const savedOf = (key: string) => (key in steps ? steps[key]!.saved : !!form && 'saved' in form && form.saved === key);
	const save: SubmitFunction = ({ formData }) => {
		const key = String(formData.get('stepKey')), value = String(formData.get('status'));
		steps[key] = { value, error: null, saved: false };
		return async ({ result, update }) => {
			if (result.type === 'success') { steps[key] = { value, error: null, saved: true }; await update({ reset: false }); return; }
			steps[key] = { value, error: result.type === 'failure' ? failureMessage(result.data) ?? 'Not saved.' : LOST, saved: false };
		};
	};
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<!-- the data is complete when the server renders the page, so data-ready is set from the start (the pilot checks read
	it from the served HTML); data-hydrated marks when the page's controls work -->
<main id="main" tabindex="-1" data-ready="enforcement_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Enforcement Roadmap" section="Enforcement Roadmap" caseName={data.version.titleName} subtitle={data.content.subtitle} />
	{#if data.content.why}
		<div class="card narr"><h3>Why this matters</h3><Narrative text={data.content.why} resultsVersion={vid} known={data.known} /></div>
	{/if}
	{#each data.phases as ph (ph)}
		<div class="card pad0">
			<div class="chead">{ph}</div>
			<div class="wrap">
				<table>
					<thead><tr><th>Step</th><th>Legal basis</th><th>Status</th><th>Note</th></tr></thead>
					<tbody>
						{#each data.rows.filter((r) => r.phase === ph) as r, i (r.key ?? `dup:${ph}:${i}`)}
							<tr data-step={r.key ?? 'duplicate'}>
								<td><b>{r.step}</b></td>
								<td class="ex"><Narrative text={r.basis} resultsVersion={vid} known={data.known} /></td>
								<td>
									{#if r.key}
										<form method="POST" action="?/status" use:enhance={save}>
											<input type="hidden" name="stepKey" value={r.key} />
											<select name="status" aria-label="Status" value={valueOf(r)} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
												{#each statusOptions(r.status) as o (o)}<option value={o}>{o}</option>{/each}
											</select>
											<noscript><button type="submit">Save</button></noscript>
											{#if errorOf(r.key)}<small class="error" role="alert" data-save-error>{errorOf(r.key)}</small>
											{:else if savedOf(r.key)}<small class="ok" data-saved>Saved</small>{/if}
											{#if r.override !== null && r.override !== r.status}<small data-imported>Imported status: {r.status}</small>{/if}
										</form>
									{:else}
										{r.status} <small class="warning-inline" data-duplicate>Another step has the same phase and name, so no status can be saved for it.</small>
									{/if}
								</td>
								<td class="ex"><Narrative text={r.note} resultsVersion={vid} known={data.known} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else}
		<div class="card"><div class="empty">{data.present ? 'No enforcement steps in this results package.' : 'This results package has no enforcement roadmap.'}</div></div>
	{/each}
	<p class="tag">Legal framework is a working aide — verify each authority (see Authorities tab) before relying on it.</p>
	<SourceNote text={ANALYSIS_NOTE} />
</main>

<style>
	.pad0 { padding: 0; overflow-x: auto; }
	.chead { font-weight: 600; padding: 0.5rem 0.75rem; border-bottom: 1px solid #d5d9e0; }
	small { display: block; }
	.empty { color: #555; padding: 1rem; text-align: center; }
	.tag { font-size: 0.9rem; color: #444; }
	td form { margin: 0; }
	select { max-width: 150px; }
</style>
