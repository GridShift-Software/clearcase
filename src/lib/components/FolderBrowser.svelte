<script lang="ts">
	// The Import page's folder browser (GRS-70): it lists one folder at a time through /api/browse (names, kinds and
	// sizes only). Folders open on click; in "case" mode a .zip is chosen on click and the open folder can be chosen
	// too, in "destination" mode only the open folder. Every control is a labelled button, so it works by keyboard.
	import type { FolderListing } from '$lib/local-case/case-pack.server';
	let { id, mode, start = null, chooseLabel, onchoose }:
		{ id: string; mode: 'case' | 'destination'; start?: string | null; chooseLabel: string; onchoose: (path: string) => void } = $props();
	let listing = $state<FolderListing | null>(null);
	let loading = $state(false);
	let failed = $state('');
	const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
	let seq = 0;
	async function go(path: string | null) {
		const n = ++seq;
		loading = true;
		try {
			const r = await fetch(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
			if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
			const l = (await r.json()) as FolderListing;
			if (n === seq) { listing = l; failed = ''; }
		} catch (e) {
			if (n === seq) failed = `The folder cannot be listed: ${(e as Error).message}`;
		} finally {
			if (n === seq) loading = false;
		}
	}
	// the first listing only: later moves come from the buttons
	$effect(() => { void go(start); });
	const rows = $derived((listing?.entries ?? []).filter((e) => mode === 'case' || e.kind === 'folder'));
</script>

<div class="browser" id={id} aria-busy={loading}>
	{#if listing}
		<nav aria-label="Shortcuts" class="row">
			{#each listing.shortcuts as s (s.path)}<button type="button" class="link" onclick={() => go(s.path)}>{s.name}</button>{/each}
		</nav>
		<nav aria-label="Current folder" class="row">
			<button type="button" id="{id}-up" disabled={!listing.parent} onclick={() => go(listing!.parent)} aria-label="Up one folder">↑ Up</button>
			<ol class="crumbs">
				{#each listing.crumbs as c, i (c.path)}
					<li>{#if i === listing.crumbs.length - 1}<span aria-current="location" class="wrap">{c.name}</span>{:else}<button type="button" class="link" onclick={() => go(c.path)}>{c.name}</button>{/if}</li>
				{/each}
			</ol>
		</nav>
		<p><button type="button" id="{id}-choose-folder" disabled={!!listing.error} onclick={() => onchoose(listing!.path)}>{chooseLabel}</button></p>
		{#if listing.error}<p class="error" role="alert">{listing.error}</p>{/if}
		<table class="entries">
			<caption class="sr-only">Contents of {listing.path}</caption>
			<thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Size</th></tr></thead>
			<tbody>
				{#each rows as e (e.path)}
					<tr>
						<td>
							{#if e.kind === 'folder'}<button type="button" class="link" onclick={() => go(e.path)} aria-label="Open folder {e.name}">📁 {e.name}</button>
							{:else}<button type="button" class="link" data-zip onclick={() => onchoose(e.path)} aria-label="Choose case pack {e.name}">🗜 {e.name}</button>{/if}
						</td>
						<td>{e.kind === 'folder' ? 'Folder' : 'Case pack (.zip)'}</td>
						<td>{e.size === null ? '—' : size(e.size)}</td>
					</tr>
				{:else}
					<tr><td colspan="3">{mode === 'case' ? 'No folders or .zip files here.' : 'No folders here.'}</td></tr>
				{/each}
			</tbody>
		</table>
		{#if listing.truncated}<p><small>Only the first entries are listed.</small></p>{/if}
	{:else if failed}
		<p class="error" role="alert">{failed}</p>
	{:else}
		<p role="status">Listing…</p>
	{/if}
</div>

<style>
	.browser { border: 1px solid #ccc; padding: 0.5rem; max-width: 60rem; }
	.row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.25rem; }
	.crumbs { display: flex; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; }
	.crumbs li + li::before { content: '/'; padding: 0 0.25rem; }
	.entries { width: 100%; }
	.entries tbody { display: block; max-height: 22rem; overflow-y: auto; }
	.entries thead, .entries tbody tr { display: table; width: 100%; table-layout: fixed; }
	.entries th:nth-child(1), .entries td:nth-child(1) { width: 60%; overflow-wrap: anywhere; }
	.link { background: none; border: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; text-align: left; font: inherit; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
