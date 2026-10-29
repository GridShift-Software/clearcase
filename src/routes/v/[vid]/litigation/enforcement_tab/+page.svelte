<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import LeaveGuard from '$lib/views/litigation/LeaveGuard.svelte';
	import SourceNote from '$lib/views/litigation/SourceNote.svelte';
	import { shownStatus, statusOptions } from '$lib/views/litigation/enforcement';
	import { ANALYSIS_NOTE } from '$lib/views/litigation/notes';
	import { lostMessage, refused, type Failure } from '$lib/views/litigation/submit';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import { writeAccess } from '$lib/components/write-access';
	import { RELOAD_UNAVAILABLE, reloader } from '$lib/components/reload.svelte';
	let { data, form } = $props();
	const access = writeAccess();
	const vid = $derived(data.version.id);
	type Row = (typeof data.rows)[number];
	type Step = { value: string | null; sent: string | null; busy: boolean; pending: boolean; error: Failure | null; saved: boolean };
	const blank = (): Step => ({ value: null, sent: null, busy: false, pending: false, error: null, saved: false });
	type Answer = { op?: string; choices?: Record<string, string>; errors?: Record<string, Failure>; savedKeys?: string[] } | null;
	let steps = $state<Record<string, Step>>(untrack(() => {
		const a = form as Answer, out: Record<string, Step> = {};
		if (a?.op !== 'status') return out;
		for (const [k, v] of Object.entries(a.choices ?? {})) {
			if (a.errors?.[k]) out[k] = { ...blank(), value: v, sent: v, error: a.errors[k]! };
			else if (a.savedKeys?.includes(k)) out[k] = { ...blank(), sent: v, saved: true };
		}
		return out;
	}));
	const rl = reloader();
	const stepOf = (key: string) => (steps[key] ??= blank());
	const valueOf = (r: Row) => (r.key && steps[r.key]?.value) ?? shownStatus(r);
	const savedOf = (r: Row) => !!r.key && !!steps[r.key]?.saved && steps[r.key]!.value === null && shownStatus(r) === steps[r.key]!.sent;
	const unsaved = $derived(Object.values(steps).some((s) => s.busy || s.error !== null || s.value !== null));
	let formEl = $state<HTMLFormElement>();
	let current: string | null = null;
	function save(key: string) {
		const s = stepOf(key);
		if (s.busy) { s.pending = true; return; }
		current = key;
		formEl?.requestSubmit();
	}
	function choose(key: string, value: string) {
		const s = stepOf(key);
		s.value = value;
		s.saved = false;
		save(key);
	}
	const submit: SubmitFunction = ({ formData, cancel }) => {
		const key = current;
		current = null;
		if (!key) { cancel(); return; }
		const s = stepOf(key), row = data.rows.find((r) => r.key === key);
		const value = s.value ?? (row ? shownStatus(row) : '');
		for (const k of [...formData.keys()]) formData.delete(k);
		formData.set('stepKey', key);
		formData.set('status', value);
		formData.set('version', row?.version ?? 'none');
		Object.assign(s, { busy: true, pending: false, error: null, saved: false, sent: value });
		return async ({ result }) => {
			try {
				if (result.type === 'success') {
					await rl.reload();
					if (s.value === value) Object.assign(s, { value: null, saved: true });
				} else if (result.type === 'failure') {
					s.error = refused(result.data, 'Not saved.');
					if (result.status === 409) await rl.reload();
				} else if (result.type === 'redirect') await applyAction(result);
				else s.error = lostMessage('status', result.status);
			} finally {
				s.busy = false;
			}
			if (s.pending) { s.pending = false; if (!s.error && s.value !== null && s.value !== value) save(key); }
		};
	};
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="enforcement_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Enforcement Roadmap" section="Enforcement Roadmap" caseName={data.version.titleName} subtitle={data.content.subtitle} />
	{#if rl.lost}<p class="error" role="alert" id="reload-error">{RELOAD_UNAVAILABLE}</p>{/if}
	{#if data.content.why}
		<div class="card narr"><h3>Why this matters</h3><Narrative text={data.content.why} resultsVersion={vid} known={data.known} /></div>
	{/if}
	<form method="POST" action="?/status" id="enf-form" bind:this={formEl} use:enhance={submit}>
	{#each data.phases as ph (ph)}
		<div class="card pad0">
			<div class="chead">{ph}</div>
			<div class="wrap">
				<TableScroll label={ph}><table>
					<thead><tr><th>Step</th><th>Legal basis</th><th>Status</th><th>Note</th></tr></thead>
					<tbody>
						{#each data.rows.filter((r) => r.phase === ph) as r, i (r.key ?? `dup:${ph}:${i}`)}
							<tr data-step={r.key ?? 'duplicate'}>
								<td><b>{r.step}</b></td>
								<td class="ex"><Narrative text={r.basis} resultsVersion={vid} known={data.known} /></td>
								<td>
									{#if r.key && !access.canWrite}
										<span data-status-shown>{shownStatus(r)}</span>
										{#if r.override !== null && r.override !== r.status}<small data-imported>Imported status: {r.status}</small>{/if}
									{:else if r.key}
										{@const key = r.key}
										<input type="hidden" name={`was:${key}`} value={shownStatus(r)} />
										<input type="hidden" name={`ver:${key}`} value={r.version} />
										<select name={`status:${key}`} aria-label="Status" value={valueOf(r)} aria-busy={steps[key]?.busy ? 'true' : null} onchange={(e) => choose(key, e.currentTarget.value)}>
											{#each statusOptions(r.status, r.override) as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
										</select>
										<noscript><button type="submit">Save</button></noscript>
										{#if steps[key]?.busy}<small role="status" data-saving>Saving…</small>{/if}
										{#if steps[key]?.error}
											<small class="error" role="alert" data-save-error>{steps[key].error.message}</small>
											{#if steps[key].error.retry}<button type="button" class="ghost" data-retry disabled={steps[key].busy} onclick={() => save(key)}>Retry</button>{/if}
										{:else if savedOf(r)}<small class="ok" data-saved>Saved</small>{/if}
										{#if r.override !== null && r.override !== r.status}<small data-imported>Imported status: {r.status}</small>{/if}
									{:else}
										{r.status} <small class="warning-inline" data-duplicate>Another step has the same phase and name, so no status can be saved for it.</small>
									{/if}
								</td>
								<td class="ex"><Narrative text={r.note} resultsVersion={vid} known={data.known} /></td>
							</tr>
						{/each}
					</tbody>
				</table></TableScroll>
			</div>
		</div>
	{:else}
		<div class="card"><div class="empty">{data.present ? 'No enforcement steps in this results package.' : 'This results package has no enforcement roadmap.'}</div></div>
	{/each}
	</form>
	<p class="tag">Legal framework is a working aide — verify each authority (see Authorities tab) before relying on it.</p>
	<SourceNote text={ANALYSIS_NOTE} />
	<LeaveGuard {unsaved} what="A status you chose is not saved." />
</main>

<style>
	.pad0 { padding: 0; }
	small { display: block; }
	#enf-form { margin: 0; }
	select { max-width: 150px; }
</style>
