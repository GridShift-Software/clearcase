<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { plural } from '$lib/components/format';
	import { versionPath } from '$lib/local-case/model';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	const run = $derived(data.run);
	let busy = $state<string | null>(null);
	let ready = $state(false);
	onMount(() => { ready = true; performance.mark('cc-ready'); });
	const submit = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => { await update({ reset: false }); busy = null; };
	};
	const BUNDLE_HELP = 'Bundle and ref prefix follow the top-level folder: the prefix most used there in this version, else the folder name (ORIGINAL, SUPPLEMENTARY, CORRESPONDENCE, PLEADINGS).';
</script>

<main id="main" tabindex="-1" data-ready="rescan_tab" data-hydrated={ready ? '' : undefined}>
	<PageHeader heading="Rescan & Update" section="Rescan & Update" caseName={data.version.titleName} subtitle="Compare the case folder with this results version">
		{#snippet actions()}
			<a id="rescan-index" href="{versionPath(data.version.id)}/system/rescan_tab/index.json" download={data.exportName.name}>Write updated index to file</a>
			<small class="export-note">The additions as v5's rescan index, {data.exportName.name}; the imported results are not changed.{#if data.exportName.note} <span data-export-note>{data.exportName.note}</span>{/if}</small>
		{/snippet}
	</PageHeader>

	<p>Case folder: <code class="wrap" id="case-folder">{data.caseFolder}</code></p>
	<p><small>A quick scan compares each file's relative path, size and date with the originals this version indexed; a full scan also reads every file and compares its SHA-256, so it finds a file changed without a change of size. {BUNDLE_HELP} New files are listed in every document view as “not yet indexed” until a new results version from processing includes them.</small></p>

	<form method="POST" action="?/scan" use:enhance={submit('scan')} id="scan-form">
		<fieldset disabled={busy !== null}>
			<legend class="visually-hidden">Rescan</legend>
			<button id="rescan-now" name="mode" value="quick">Rescan now</button>
			<button id="rescan-full" name="mode" value="full">Full scan (reads every file)</button>
			{#if busy === 'scan'}<span role="status" id="scan-busy">Scanning…</span>{/if}
		</fieldset>
	</form>
	{#if form && 'message' in form && form.message}<p class="error wrap" role="alert" id="rescan-error">{form.message}</p>{/if}
	{#if form && 'cleared' in form}<p role="status" id="rescan-cleared">{plural(form.cleared ?? 0, 'addition')} cleared. Their refs are not issued again.</p>{/if}

	<section aria-labelledby="rescan-status-h">
		<h2 id="rescan-status-h">Last scan</h2>
		{#if run}
			<p id="rescan-status" data-current={run.current ? 'true' : 'false'}>New: <b id="count-new">{run.counts.added}</b> · Already indexed: <b id="count-indexed">{run.counts.scanned - run.counts.added}</b> · Total scanned: <b id="count-scanned">{run.counts.scanned}</b> · Changed: <b id="count-changed">{run.counts.changed}</b> · Removed: <b id="count-removed">{run.counts.removed}</b></p>
			<p id="rescan-verdict" class={run.current ? 'ok' : 'warning-inline'}>{run.mode === 'full' ? 'Full scan' : 'Quick scan'} <time datetime={run.at}>{run.at.slice(0, 16).replace('T', ' ')}</time>, {run.ms} ms: {run.verdict}</p>
		{:else}
			<p id="rescan-status">This version's case folder has not been scanned yet.</p>
		{/if}
	</section>

	<section aria-labelledby="added-h">
		<h2 id="added-h">Additions ({data.added.length})</h2>
		{#if data.added.length}
			<TableScroll label="Additions"><table id="rescan-added">
				<thead><tr><th scope="col">Ref</th><th scope="col">Date</th><th scope="col">Filename</th><th scope="col">Type</th><th scope="col">Bundle</th><th scope="col">Status</th><th scope="col">Doc</th></tr></thead>
				<tbody>
					{#each data.added as r (r.path)}
						<tr data-ref={r.ref}><td>{r.ref}</td><td>{r.date}</td><td class="wrap">{r.path}</td><td>{r.docType}</td><td>{r.bundle}</td><td>{r.processing} processing</td><td><a href={r.href}>open</a></td></tr>
					{/each}
				</tbody>
			</table></TableScroll>
			<form method="POST" action="?/clear" use:enhance={submit('clear')} id="clear-form">
				<fieldset disabled={busy !== null}>
					<legend>Clear rescan additions</legend>
					<label><input type="checkbox" name="confirm" value="yes" required id="clear-confirm" /> Yes, clear the additions (their refs are never issued again)</label>
					<button id="rescan-clear">Clear rescan additions</button>
				</fieldset>
			</form>
		{:else}
			<p>No files in the case folder are missing from this version{run ? '' : ' (scan to find out)'}.</p>
		{/if}
		{#if data.withdrawn.length}
			<p id="rescan-withdrawn"><small>{plural(data.withdrawn.length, 'earlier addition')} no longer in the folder: {data.withdrawn.map((r) => r.ref).join(', ')}. Their refs stay issued.</small></p>
		{/if}
	</section>

	<section aria-labelledby="changed-h">
		<h2 id="changed-h">Changed or removed originals ({data.changed.length + data.removed.length})</h2>
		{#if data.changed.length + data.removed.length}
			<TableScroll label="Changed or removed originals"><table id="rescan-changed">
				<thead><tr><th scope="col">Ref</th><th scope="col">Path</th><th scope="col">Finding</th></tr></thead>
				<tbody>
					{#each data.changed as r (r.path)}<tr data-ref={r.ref}><td>{r.ref}</td><td class="wrap">{r.path}</td><td>Changed ({r.evidence === 'sha256' ? 'content differs, same size' : 'size differs'})</td></tr>{/each}
					{#each data.removed as r (r.path)}<tr data-ref={r.ref}><td>{r.ref}</td><td class="wrap">{r.path}</td><td>Removed from the case folder</td></tr>{/each}
				</tbody>
			</table></TableScroll>
			<p><small>The analysis of these documents comes from the files as they were at import. Process the case folder again for analysis of the current files.</small></p>
		{:else}
			<p>None found{run && run.mode === 'quick' ? ' (a quick scan cannot see a change that keeps the size; run a full scan)' : ''}.</p>
		{/if}
	</section>
</main>

<style>
	fieldset { border: 0; padding: 0; margin: .4rem 0; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
</style>
