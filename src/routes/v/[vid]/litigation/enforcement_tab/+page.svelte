<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { shownStatus, statusOptions } from '$lib/views/litigation/enforcement';
	import { ANALYSIS_NOTE } from '$lib/views/litigation/notes';
	import { keepInput } from '$lib/views/litigation/submit';
	let { data, form } = $props();
	const vid = $derived(data.version.id);
	// the value the user chose, kept when a save fails (busy store or lost request) until it is saved
	let chosen = $state<Record<string, string>>({});
	let pending = $state<string | null>(null);
	let lost = $state<{ key: string; message: string } | null>(null);
	const failed = $derived(form && 'values' in form && form.values ? (form.values as { stepKey: string; status: string }) : null);
	const savedKey = $derived(form && 'saved' in form ? (form.saved as string) : null);
	const errorFor = (key: string) => (lost?.key === key ? lost.message : failed?.stepKey === key && form && 'message' in form ? (form.message as string) : null);
	const valueOf = (r: (typeof data.rows)[number]) => (r.key && chosen[r.key]) || (r.key && failed?.stepKey === r.key ? failed.status : null) || shownStatus(r);
	const submit = keepInput((m) => { if (pending) lost = { key: pending, message: m }; }, () => { lost = null; });
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'enforcement_tab' : null}>
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
										<form method="POST" action="?/status" use:enhance={submit}>
											<input type="hidden" name="stepKey" value={r.key} />
											<select name="status" aria-label="Status" value={valueOf(r)} onchange={(e) => { chosen[r.key!] = e.currentTarget.value; pending = r.key; e.currentTarget.form?.requestSubmit(); }}>
												{#each statusOptions(r.status) as o (o)}<option value={o}>{o}</option>{/each}
											</select>
											<noscript><button type="submit">Save</button></noscript>
											{#if errorFor(r.key)}<small class="error" role="alert" data-save-error>{errorFor(r.key)}</small>
											{:else if savedKey === r.key}<small class="ok" data-saved>Saved</small>{/if}
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
