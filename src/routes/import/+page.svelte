<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data, form } = $props();
	let busy = $state(false);
	let ready = $state(false);
	onMount(() => { ready = true; });
	let progress = $state('');
	const mb = (n: number) => (n / 1e6).toFixed(1);
	// With JS: poll validation progress while the import request runs. Without JS the plain form post works the same.
	const track = () => {
		busy = true;
		const t = setInterval(async () => {
			const p = await (await fetch('/api/import-progress')).json().catch(() => null);
			const g = p?.progress;
			progress = !g ? 'starting' : g.phase === 'hash' ? `hashing originals: ${g.done}/${g.total} files, ${mb(g.bytesDone)}/${mb(g.bytesTotal)} MB` : `${g.phase} ${g.done}/${g.total}`;
		}, 250);
		return async ({ update }: { update: () => Promise<void> }) => { clearInterval(t); busy = false; progress = ''; await update(); };
	};
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'import' : null}>
	<PageHeader heading="Import a results package" section="Import results" />
	<form method="POST" action="?/import" use:enhance={track} id="import-form">
		<p><label for="caseFolder">Case folder (the folder with the originals)</label><br /><input id="caseFolder" name="caseFolder" size="100" value={form?.caseFolder ?? ''} required autocomplete="off" /></p>
		<p><label for="packageSource">Results package (folder or .zip)</label><br /><input id="packageSource" name="packageSource" size="100" value={form?.packageSource ?? ''} required autocomplete="off" /></p>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		<button disabled={busy} id="validate">Validate package</button>
		{#if busy}<span id="import-progress" role="status">{progress || 'validating…'}</span>{/if}
		<p><small>Validation reads the package and the referenced originals only, writes nothing into the case folder and never changes the active version. A valid package becomes a candidate you can preview and then activate.</small></p>
	</form>
	{#if busy || data.running}
		<form method="POST" action="?/cancel" use:enhance><button id="cancel-import">Cancel the running import</button></form>
	{/if}
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
