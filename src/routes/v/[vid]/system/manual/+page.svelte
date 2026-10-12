<script lang="ts">
	// Manual (GRS-20): how to use the workspace, offline. The figures come from this results version; the two lists
	// are links (?list=ocr, ?list=links), so they work without JavaScript and Back returns to the page as it was.
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { viewById, viewHref } from '$lib/components/views';
	let { data } = $props();
	const b = $derived(data.badges);
	const vid = $derived(data.version.id);
	const href = (id: string) => viewHref(vid, viewById(id)!);
	let ready = $state(false);
	onMount(() => { ready = true; performance.mark('cc-ready'); });
	const RESULT = { found: 'found in the case folder', missing: 'not found in the case folder', outside: 'not a path inside the case folder' } as const;
</script>

<main id="main" tabindex="-1" data-ready="manual" data-hydrated={ready ? '' : undefined}>
	<PageHeader heading="Manual" section="Manual" caseName={data.version.titleName} subtitle="How this workspace works" />

	<ul class="badges" id="manual-badges">
		<li>Documents <b>{b.documents.toLocaleString('en')}</b>{b.viaRescan ? ` (+${b.viaRescan} via rescan)` : ''}</li>
		<li>Emails <b>{b.emails.toLocaleString('en')}</b></li>
		<li>People <b>{b.people === null ? '—' : b.people.toLocaleString('en')}</b></li>
		<li>Scanned (none) <b>{b.textNone.toLocaleString('en')}</b></li>
		<li>Pending <b>{b.textPending.toLocaleString('en')}</b></li>
	</ul>

	<section aria-labelledby="m-start">
		<h2 id="m-start">Starting and importing</h2>
		<p>ClearCase runs on this computer and needs no network. Start it, open it in the browser at the address it prints, and import a case: type the path of the case folder (the originals) and of the results package that processing produced from it. The import checks the package and every original before anything is shown; a case opens on its Overview. Importing a newer package makes a new results version; the previous one stays available until you activate the new one, and the Overview can return to it.</p>
		<p>Refs name each document: the prefix is its bundle (for example OD- original discovery, SD- supplementary discovery, EM- correspondence, PN- pleadings; a case may use others), the number its place in the bundle. A document page shows its original, its extracted text and your notes.</p>
	</section>

	<section aria-labelledby="m-search">
		<h2 id="m-search">What search covers</h2>
		<p>Search finds words only in documents that have extracted text. Documents without it can be found by their ref, filename and other metadata only: {b.textNone.toLocaleString('en')} have no text (scanned images that still need OCR) and {b.textPending.toLocaleString('en')} are pending. Files a rescan found have no extracted text until a new results package from processing includes them.</p>
		<p><a id="manual-ocr" href="?list=ocr" data-sveltekit-noscroll>List scanned documents needing OCR ({data.ocrCount})</a></p>
		{#if data.ocr}
			<div class="scroll box"><table id="manual-ocr-list"><thead><tr><th scope="col">Ref</th><th scope="col">Bundle</th><th scope="col">Filename</th></tr></thead>
				<tbody>{#each data.ocr as r (r.ref)}<tr><td><a href={r.href}>{r.ref}</a></td><td>{r.bundle}</td><td class="wrap">{r.filename}</td></tr>{/each}</tbody></table></div>
		{/if}
	</section>

	<section aria-labelledby="m-fresh">
		<h2 id="m-fresh">Freshness and rescans</h2>
		<p>The Overview's Freshness card says when the results were built and how many documents are indexed. When files are added to, changed in or removed from the case folder, open <a id="manual-rescan" href={href('rescan_tab')}>Rescan &amp; Update</a>. A quick rescan compares names, sizes and dates; a full rescan also compares contents. Neither changes the analysis: only a new results package does, and a quick rescan never says the analysis is current.</p>
	</section>

	<section aria-labelledby="m-work">
		<h2 id="m-work">Your work and backups</h2>
		<p>Notes and every register you fill in are saved on this computer as you work, per case. <a id="manual-backup" href={href('backup_tab')}>Backup / Restore</a> saves all of a case's work to one file and restores it, on this computer or another. The file holds your work, the case's identity and the format version, not the originals or the results package: keep the case folder and the package as well. A restore checks the file first and changes nothing if the file is damaged, of another format or of another case. A v5 browser backup (ess_dcs_backup.json) is recognised and its stores listed; importing v5 browser state is not available yet.</p>
		{#if data.quantum}<p>Amounts: the headline amount due is the source's figure for {data.quantum.ref}{data.quantum.date ? ` as at ${data.quantum.date}` : ''}; check it against the documents before relying on it.</p>{/if}
	</section>

	<section aria-labelledby="m-links">
		<h2 id="m-links">Checking links to originals</h2>
		{#if data.sampleCount !== null}
			<p><a id="manual-verify" href="?list=links" data-sveltekit-noscroll>Verify link sample ({data.sampleCount})</a> checks each link of the package's sample against the case folder now.</p>
			{#if data.links}
				<p role="status" id="manual-verify-result">{data.links.filter((l) => l.result === 'found').length} of {data.links.length} found in the case folder.</p>
				<div class="scroll box"><table id="manual-link-list"><thead><tr><th scope="col">Ref</th><th scope="col">Bundle</th><th scope="col">Filename</th><th scope="col">Result</th></tr></thead>
					<tbody>{#each data.links as r, i (i)}<tr data-result={r.result}><td><a href={r.href}>{r.ref}</a></td><td>{r.bundle}</td><td class="wrap">{r.filename}</td><td>{RESULT[r.result]}</td></tr>{/each}</tbody></table></div>
			{/if}
		{:else}
			<p>This results package has no link sample. Every original was checked when the version was imported; a document page checks its original again when it is opened.</p>
		{/if}
	</section>
</main>

<style>
	.badges { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; }
	.badges li { background: #eef2f6; border-radius: 4px; padding: .15rem .5rem; }
	.scroll { overflow-x: auto; max-width: 100%; }
	.box { max-height: 360px; overflow-y: auto; }
	td, th { padding: 2px 8px; text-align: left; }
	section { max-width: 60rem; }
</style>
