<script lang="ts">
	// Backup / Restore (GRS-20): every saved table of this case in one file, and a checked restore that changes nothing
	// unless the whole file is valid and belongs to this case.
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { plural } from '$lib/components/format';
	import { versionPath } from '$lib/local-case/model';
	let { data, form } = $props();
	let busy = $state(false);
	let ready = $state(false);
	let tooLarge = $state<string | null>(null);
	// the typed path is component state, so neither a submit nor its result clears it; without JavaScript a refused
	// restore renders it back from the form result
	const typedPath = () => (form && 'path' in form ? (form.path ?? '') : '');
	let path = $state(typedPath());
	onMount(() => { ready = true; performance.mark('cc-ready'); });
	const mib = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MiB`;
	function picked(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		tooLarge = f && f.size > data.maxBytes ? `${f.name} is larger than ${mib(data.maxBytes)}, so it is not a backup this version can restore.` : null;
	}
	const LEGACY: Record<string, string> = { imported: 'imported', empty: 'empty in the file (skipped)', 'no-importer': 'not imported: no importer for this store yet', 'legacy-unused': 'not imported: v5 never used this key', unknown: 'not imported: unknown key', failed: 'failed', 'not-run': 'not imported (an earlier importer failed)' };
</script>

<main id="main" tabindex="-1" data-ready="backup_tab" data-hydrated={ready ? '' : undefined}>
	<PageHeader heading="Backup / Restore" section="Backup / Restore" caseName={data.version.titleName} subtitle="Save this case's work to a file, or restore it from one">
		{#snippet actions()}
			<a id="backup-export" href="{versionPath(data.version.id)}/system/backup_tab/download" download={data.name}>Export all state</a>
			<small class="export-note wrap">{data.name}</small>
		{/snippet}
	</PageHeader>

	<p id="backup-binaries" class="warning"><b>Binaries are not included.</b> {data.note}</p>
	<p><small>The file covers every table of saved work, so a table a later version adds is carried too; it also replaces v5's browser backup, which missed five of v5's 21 stores. A restore checks the whole file before it changes anything, keeps a copy of the current work first (a file you can import again), and replaces only this case's work; other cases are left as they are. Accepted warnings are never carried.</small></p>

	<section aria-labelledby="tables-h">
		<h2 id="tables-h">What a backup holds now ({plural(data.rows, 'row')})</h2>
		<div class="scroll"><table id="backup-tables">
			<thead><tr><th scope="col">Table</th><th scope="col">Owner</th><th scope="col" class="num">Rows</th></tr></thead>
			<tbody>{#each data.tables as t (t.name)}<tr><td><code class="wrap">{t.name}</code></td><td>{t.owner}</td><td class="num">{t.rows}</td></tr>{/each}</tbody>
		</table></div>
	</section>

	{#if data.excluded.length}
		<section aria-labelledby="excluded-h">
			<h2 id="excluded-h">Not in the backup</h2>
			<ul id="backup-excluded" class="warning">
				{#each data.excluded as x (x.name)}<li><b>Not in the backup:</b> <code class="wrap">{x.name}</code> ({plural(x.rows, 'row')}): <span class="wrap">{x.reason}</span></li>{/each}
			</ul>
		</section>
	{/if}

	<section aria-labelledby="restore-h">
		<h2 id="restore-h">Import state</h2>
		<form method="POST" action="?/restore" enctype="multipart/form-data" id="restore-form"
			use:enhance={({ cancel }) => {
				if (tooLarge) { cancel(); return; }
				busy = true;
				return async ({ update }) => { await update({ reset: false }); busy = false; };
			}}>
			<fieldset disabled={busy}>
				<legend class="visually-hidden">Restore a backup</legend>
				<p><label for="restore-file">Backup file (up to {mib(data.maxBytes)})</label><br /><input type="file" name="file" id="restore-file" accept="application/json,.json" onchange={picked} /></p>
				<p><label for="restore-path">or its full path on this computer</label><br /><input type="text" name="path" id="restore-path" bind:value={path} autocomplete="off" spellcheck="false" placeholder="/home/me/clearcase-backup.json" /></p>
				<p><label><input type="checkbox" name="confirm" value="yes" required id="restore-confirm" /> Yes, replace this case’s work with the backup’s</label></p>
				<button id="restore-submit">Import state</button>
				{#if busy}<span role="status" id="restore-busy">Checking and restoring…</span>{/if}
			</fieldset>
		</form>
		{#if tooLarge}<p class="error wrap" role="alert" id="restore-too-large">{tooLarge} Nothing was sent.</p>{/if}
		{#if form && 'message' in form && form.message}<p class="error wrap" role="alert" id="restore-error" data-code={'code' in form ? form.code : ''}>{form.message}</p>{/if}
		{#if form && 'restored' in form && form.restored}
			<p role="status" id="restore-done">Restored {plural(form.restored.rows, 'row')} in {plural(form.restored.tables, 'table')} from the backup of {form.restored.createdAt.slice(0, 16).replace('T', ' ')}.{form.restored.sameVersion ? '' : ' The backup was made on another results version of this case; notes keep their anchors and show as detached where a document is not in this version.'} A copy of the work before the restore was kept in <code class="wrap" id="restore-copy">{form.restored.preRestore}</code>; it is outside the rotating backups, so later saves never remove it, and Import state can restore it.</p>
		{/if}
		{#if form && 'legacy' in form && form.legacy}
			<div role="status" id="restore-legacy">
				<p>This is a v5 browser backup (ess_dcs_backup.json). {form.legacy.changed ? `${plural(form.legacy.rows, 'row')} imported.` : 'Nothing was changed: importing v5 browser state is not available in this version.'}{form.legacy.error ? ` Import stopped: ${form.legacy.error}` : ''}{#if form.legacy.preRestore} A copy of the work before the import was kept in <code class="wrap" id="restore-copy">{form.legacy.preRestore}</code>.{/if}</p>
				<div class="scroll"><table id="legacy-keys"><thead><tr><th scope="col">Key</th><th scope="col">Result</th></tr></thead>
					<tbody>{#each form.legacy.keys as k (k.key)}<tr><td><code class="wrap">{k.key}</code></td><td>{LEGACY[k.status] ?? k.status}</td></tr>{/each}</tbody></table></div>
			</div>
		{/if}
	</section>
</main>

<style>
	.scroll { overflow-x: auto; max-width: 100%; }
	fieldset { border: 0; padding: 0; margin: 0; }
	input[type='text'] { width: min(36rem, 100%); }
	td, th { padding: 2px 8px; text-align: left; }
</style>
