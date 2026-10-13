<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import FolderBrowser from '$lib/components/FolderBrowser.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	/** which form's import is running: the case pack's or the results package's */
	let busy = $state<'' | 'case' | 'package'>('');
	let ready = $state(false);
	let progress = $state('');
	let stage = $state('');
	const mb = (n: number) => (n / 1e6).toFixed(1);
	// Open a case (GRS-70): the case pack (a .zip or a folder) and where to store it, both chosen in the folder browser
	// in a dialog. The case name starts as the pack's name and stays editable.
	let caseSource = $state('');
	let destination = $state('');
	let caseName = $state('');
	let nameEdited = false;
	let picking = $state<'' | 'case' | 'destination'>('');
	let dialog: HTMLDialogElement;
	let opener: HTMLElement | null = null;
	const packName = (p: string) => (p.replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.zip$/i, '');
	const tilde = (p: string) => (p === data.home ? '~' : p.startsWith(`${data.home}/`) ? `~${p.slice(data.home.length)}` : p);
	function pick(which: 'case' | 'destination', e: MouseEvent) {
		opener = e.currentTarget as HTMLElement;
		picking = which;
		dialog.showModal();
	}
	function chosen(p: string) {
		if (picking === 'case') { caseSource = p; if (!nameEdited) caseName = packName(p); }
		else destination = p;
		dialog.close();
	}
	onMount(() => {
		ready = true;
		// ?pick=case or ?pick=destination opens the dialog on load (the UI class suite measures it at narrow widths)
		const q = page.url.searchParams.get('pick');
		if (q === 'case' || q === 'destination') { picking = q; dialog.showModal(); }
	});
	$effect(() => {
		if (form?.caseSource) { caseSource = form.caseSource; }
		if (form?.destination) destination = form.destination;
		if (form?.caseName !== undefined) caseName = form.caseName;
	});
	const effectiveDestination = $derived(destination || data.defaultDestination);
	const stageOf = (phase: string) => (phase === 'extract' ? 'Extracting' : phase === 'find' || phase === 'convert' || phase === 'write' ? 'Converting' : 'Checking originals');
	// With JS: poll the import's progress while its request runs. Without JS the plain form post works the same.
	const track = (which: 'case' | 'package') => () => {
		busy = which;
		stage = 'Starting';
		const t = setInterval(async () => {
			const p = await (await fetch('/api/import-progress')).json().catch(() => null);
			const g = p?.progress;
			if (g) stage = stageOf(g.phase);
			progress = !g ? 'starting' : g.phase === 'hash' ? `checking originals: ${g.done}/${g.total} files, ${mb(g.bytesDone)}/${mb(g.bytesTotal)} MB`
				: g.phase === 'extract' ? `extracting the case pack: ${g.done}/${g.total} files, ${mb(g.bytesDone)}/${mb(g.bytesTotal)} MB`
				: g.phase === 'find' ? 'converting: finding the workspace HTML'
				: g.phase === 'convert' ? `converting the workspace HTML: ${g.total ? `fingerprinting originals ${g.done}/${g.total}` : 'reading it'}`
				: g.phase === 'write' ? 'converting: writing the results package'
				: g.phase === 'snapshot' || g.phase === 'validate' ? `checking originals: reading the package${g.total ? ` (${g.total} files)` : ''}`
				: g.phase === 'stat' ? `checking originals: ${g.done}/${g.total} files listed`
				: `checking originals: ${g.phase}`;
		}, 250);
		return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
			clearInterval(t);
			if (result.type === 'redirect') { stage = 'Ready to review'; progress = 'opening the report'; }
			await update();
			busy = ''; progress = ''; stage = '';
		};
	};
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'import' : null} class="import-page">
	<PageHeader heading="Open a case" section="Import results" />
	<div class="card">
		<form method="POST" action="?/importCase" use:enhance={track('case')} id="import-case-form">
			<p class="field"><label for="case-name">Case name</label><input id="case-name" name="caseName" bind:value={caseName} oninput={() => { nameEdited = true; }} placeholder="New case name" autocomplete="off" /></p>
			<section aria-labelledby="documents-heading">
				<h3 id="documents-heading">Documents</h3>
				<p class="muted">Choose the case pack as you received it (a .zip), or the folder it was extracted to. ClearCase processes it on this computer; nothing is uploaded.</p>
				{#if caseSource}<p>Case pack: <strong class="wrap" id="chosen-case">{tilde(caseSource)}</strong></p>{/if}
				<p><button type="button" class="secondary" id="add-documents" onclick={(e) => pick('case', e)}>{caseSource ? 'Change documents' : 'Add documents'}</button></p>
			</section>
			<p class="muted">Stored in <strong class="wrap" id="chosen-destination">{tilde(effectiveDestination)}</strong> <button type="button" class="secondary" id="change-destination" onclick={(e) => pick('destination', e)}>Change</button></p>
			<input type="hidden" name="caseSource" value={caseSource} />
			<input type="hidden" name="destination" value={effectiveDestination} />
			{#if form?.packMessage}<p class="error wrap" role="alert" id="import-case-error">{form.packMessage}</p>{/if}
			<p><button class="primary" disabled={!!busy || !caseSource} id="import-case">Open case</button></p>
			{#if busy === 'case'}<p class="status-row"><span class="pill" id="import-case-stage">{stage}</span> <span class="muted" id="import-case-progress" role="status">{progress || 'starting…'}</span></p>{/if}
			<p class="muted"><small>Open case extracts the pack if it is a .zip, converts the case's workspace HTML and checks every original, then shows the report. The active case changes only when you activate the new version.</small></p>
		</form>
		{#if busy || data.running}
			<form method="POST" action="?/cancel" use:enhance><button class="secondary" id="cancel-import">Cancel the running import</button></form>
		{/if}
	</div>
	<dialog bind:this={dialog} class="picker" aria-labelledby="picker-heading" onclose={() => { picking = ''; opener?.focus(); }}>
		{#if picking}
			<div class="picker-head">
				<h2 id="picker-heading">{picking === 'case' ? 'Add documents' : 'Where to store cases'}</h2>
				<button type="button" class="secondary" id="picker-close" onclick={() => dialog.close()}>Close</button>
			</div>
			{#if picking === 'case'}
				<p class="muted">Click the case pack's .zip, or open the folder it was extracted to and choose Use this folder.</p>
				<FolderBrowser id="case-browser" mode="case" chooseLabel="Use this folder" onchoose={chosen} />
			{:else}
				<p class="muted">ClearCase extracts a .zip here and writes the converted results beside the case. It never writes into a case folder.</p>
				<FolderBrowser id="destination-browser" mode="destination" chooseLabel="Store cases in this folder" onchoose={chosen} />
			{/if}
		{/if}
	</dialog>
	<h2>Already have a results package?</h2>
	<form method="POST" action="?/import" use:enhance={track('package')} id="import-form">
		<p><label for="caseFolder">Case folder (the folder with the originals)</label><br /><input id="caseFolder" name="caseFolder" size="100" value={form?.caseFolder ?? ''} required autocomplete="off" /></p>
		<p><label for="packageSource">Results package (folder or .zip)</label><br /><input id="packageSource" name="packageSource" size="100" value={form?.packageSource ?? ''} required autocomplete="off" /></p>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		<button disabled={!!busy} id="validate">Validate package</button>
		{#if busy === 'package'}<span id="import-progress" role="status">{progress || 'validating…'}</span>{/if}
		<p><small>Validation reads the package and the referenced originals only, writes nothing into the case folder and never changes the active version. A valid package becomes a candidate you can preview and then activate.</small></p>
	</form>
	<h2>Previous imports</h2>
	<TableScroll label="Previous imports"><table>
		<thead><tr><th>#</th><th>When</th><th>Case</th><th>Results version</th><th>Verdict</th><th>Outcome</th></tr></thead>
		<tbody>
			{#each data.imports as i (i.id)}
				<tr><td><a href="/import/{i.id}">{i.id}</a></td><td>{i.at}</td><td class="wrap">{i.case_id ?? '—'}</td><td><code>{i.results_version ? `${i.results_version.slice(0, 19)}…` : '—'}</code></td><td>{i.verdict}</td><td>{i.outcome}</td></tr>
			{:else}
				<tr><td colspan="6">No imports yet.</td></tr>
			{/each}
		</tbody>
	</table></TableScroll>
</main>

<style>
	/* production's new-case window (prod-inspo.md); muted text is #536477, not production's #8290a0, for 4.5:1 on white */
	.import-page :global(h1) { font-family: Georgia, 'Times New Roman', serif; font-size: 36px; font-weight: 400; }
	.card, .picker { background: #fff; color: #17212d; border: 1px solid #dce5ee; border-radius: 18px; padding: 24px; box-shadow: none; }
	.card { max-width: 48rem; margin-bottom: 1.5rem; }
	.card h3 { font-size: 15px; font-weight: 600; margin: 1rem 0 0.25rem; }
	.muted { color: #536477; }
	.field label { display: block; font-weight: 500; margin-bottom: 0.25rem; }
	.field input { width: min(100%, 28rem); box-sizing: border-box; background: #fff; border: 1px solid #dce5ee; border-radius: 10px; padding: 8px 12px; font: inherit; color: #17212d; }
	.primary, .secondary { border-radius: 10px; padding: 8px 16px; font: inherit; font-weight: 500; cursor: pointer; }
	.primary { color: #fff; border: 1px solid #0a1c34; background: linear-gradient(#1a4372 0%, #102b4e 52%, #0a1c34 100%); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 1px 2px rgba(7, 20, 38, 0.28); }
	.primary:disabled { background: #536477; border-color: #536477; cursor: not-allowed; }
	.secondary { color: #17212d; background: transparent; border: 1px solid #dce5ee; }
	.secondary:hover { border-color: #536477; }
	.status-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
	.pill { font-size: 13px; color: #245f91; background: #eaf2fa; border-radius: 10px; padding: 4px 12px; }
	.picker { width: min(56rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); box-sizing: border-box; overflow: auto; }
	.picker::backdrop { background: rgba(23, 33, 45, 0.45); }
	.picker-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
	.picker-head h2 { font-size: 15px; font-weight: 600; margin: 0; }
</style>
