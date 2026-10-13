<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import FolderBrowser from '$lib/components/FolderBrowser.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	/** which form's import is running: the click path's or the results package's */
	let busy = $state<'' | 'case' | 'package'>('');
	let ready = $state(false);
	onMount(() => { ready = true; });
	let progress = $state('');
	const mb = (n: number) => (n / 1e6).toFixed(1);
	// Import by clicking: the case (a .zip or a folder) and where to store it, both chosen in the folder browser.
	let caseSource = $state('');
	let destination = $state('');
	let pickCase = $state(true);
	let pickDest = $state(false);
	const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
	$effect(() => { if (form?.caseSource) { caseSource = form.caseSource; pickCase = false; } if (form?.destination) { destination = form.destination; pickDest = false; } });
	// With JS: poll the import's progress while its request runs. Without JS the plain form post works the same.
	const track = (which: 'case' | 'package') => () => {
		busy = which;
		const t = setInterval(async () => {
			const p = await (await fetch('/api/import-progress')).json().catch(() => null);
			const g = p?.progress;
			progress = !g ? 'starting' : g.phase === 'hash' ? `hashing originals: ${g.done}/${g.total} files, ${mb(g.bytesDone)}/${mb(g.bytesTotal)} MB`
				: g.phase === 'extract' ? `extracting the case pack: ${g.done}/${g.total} files, ${mb(g.bytesDone)}/${mb(g.bytesTotal)} MB`
				: g.phase === 'find' ? 'finding the workspace HTML'
				: g.phase === 'convert' ? `converting the workspace HTML: ${g.total ? `fingerprinting originals ${g.done}/${g.total}` : 'reading it'}`
				: g.phase === 'write' ? 'writing the results package'
				: `${g.phase} ${g.done}/${g.total}`;
		}, 250);
		return async ({ update }: { update: () => Promise<void> }) => { clearInterval(t); busy = ''; progress = ''; await update(); };
	};
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'import' : null}>
	<PageHeader heading="Import a case" section="Import results" />
	<section aria-labelledby="step-case">
		<h2 id="step-case">Step 1: Choose the case</h2>
		<p>Choose the case pack as you received it (a .zip file), or the folder it was extracted to.</p>
		{#if caseSource && !pickCase}
			<p>Case: <strong class="wrap" id="chosen-case">{caseSource}</strong> <button type="button" id="change-case" onclick={() => { pickCase = true; }}>Change</button></p>
		{:else}
			<FolderBrowser id="case-browser" mode="case" chooseLabel="Use this folder as the case" onchoose={(p) => { caseSource = p; pickCase = false; if (!destination) pickDest = true; }} />
		{/if}
	</section>
	<section aria-labelledby="step-dest">
		<h2 id="step-dest">Step 2: Choose where to store it</h2>
		<p>ClearCase extracts a .zip here and writes the converted results beside the case. It never writes into a case folder.</p>
		{#if destination && !pickDest}
			<p>Store in: <strong class="wrap" id="chosen-destination">{destination}</strong> <button type="button" id="change-destination" onclick={() => { pickDest = true; }}>Change</button></p>
		{:else if pickDest}
			<FolderBrowser id="destination-browser" mode="destination" start={caseSource ? parentOf(caseSource) : null} chooseLabel="Store it in this folder" onchoose={(p) => { destination = p; pickDest = false; }} />
		{:else}
			<p><button type="button" id="choose-destination" onclick={() => { pickDest = true; }}>Choose a folder</button></p>
		{/if}
	</section>
	<form method="POST" action="?/importCase" use:enhance={track('case')} id="import-case-form">
		<input type="hidden" name="caseSource" value={caseSource} />
		<input type="hidden" name="destination" value={destination} />
		{#if form?.packMessage}<p class="error wrap" role="alert" id="import-case-error">{form.packMessage}</p>{/if}
		<button disabled={!!busy || !caseSource || !destination} id="import-case">Import</button>
		{#if busy === 'case'}<span id="import-case-progress" role="status">{progress || 'starting…'}</span>{/if}
		<p><small>Import extracts the pack if it is a .zip, converts the case's workspace HTML and validates the result, then shows the preview. The active case changes only when you activate the new version.</small></p>
	</form>
	{#if busy || data.running}
		<form method="POST" action="?/cancel" use:enhance><button id="cancel-import">Cancel the running import</button></form>
	{/if}
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
