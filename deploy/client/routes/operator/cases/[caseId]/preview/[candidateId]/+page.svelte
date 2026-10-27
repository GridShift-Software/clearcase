<script lang="ts">
	import { money } from '$lib/components/format';
	import { excerptPreview, statusLabel } from '$lib/local-case/chronology';
	import { displayFilename, revealInvisible } from '$lib/views/hosted/display';
	import type { load } from './+page.server';
	// A private review surface for one exact candidate. It shows what is stored; it approves, signs off and publishes
	// nothing, and it is not the readiness, render or required-view check.
	let { data }: { data: Awaited<ReturnType<typeof load>> } = $props();
	const o = $derived(data.overview), c = $derived(data.chronology);
	const n = (x: number) => x.toLocaleString('en');
	const sorted = (m: [string, number][]) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
</script>

<svelte:head><title>PRIVATE candidate preview — not published</title></svelte:head>
<main id="main" tabindex="-1" data-view="private-candidate-preview" data-published="false" data-results-version={data.resultsVersion} data-candidate-id={data.candidateId}>
	<p><a href={data.workbenchHref}>Operator workbench</a> › Private preview</p>
	<header class="private" role="note" aria-label="Private, not published">
		<h1>PRIVATE — NOT PUBLISHED</h1>
		<p>Operator preview of one private candidate. Clients cannot see it. Nothing here signs off or publishes; review it, then sign off the exact version separately in the workbench.</p>
		<dl>
			<div><dt>resultsVersion</dt><dd><code data-results-version>{data.resultsVersion}</code></dd></div>
			<div><dt>Candidate</dt><dd><code>{data.candidateId}</code> ({data.origin})</dd></div>
			<div><dt>Link</dt><dd><code>{data.linkId}</code>, linked {data.linkedAt}</dd></div>
			<div><dt>Manifest SHA-256</dt><dd><code>{data.manifestSha256}</code></dd></div>
			<div><dt>Package input revision</dt><dd><code>{data.packageInputRevisionId}</code></dd></div>
			<div><dt>Submission revision</dt><dd><code>{data.submissionRevisionId}</code></dd></div>
			<div><dt>Attribution</dt><dd>{data.attribution}</dd></div>
		</dl>
	</header>

	<section aria-labelledby="summary-title" data-preview-section="summary">
		<h2 id="summary-title">Summary</h2>
		<p>{revealInvisible(o.matterTitle ?? o.caseName)}</p>
		<p><small>Produced {revealInvisible(o.created)} by {revealInvisible(o.producer)} from {revealInvisible(o.inputKind)} input.</small></p>
		<dl class="kpis">
			<div><dt>Documents indexed</dt><dd data-count={o.documents}>{n(o.documents)}</dd></div>
			<div><dt>Invoices</dt><dd>{n(o.counts.invoices)}</dd></div>
			<div><dt>Emails</dt><dd>{n(o.counts.emails)}</dd></div>
			<div><dt>Without extracted text</dt><dd>{n(o.counts.withoutText)}</dd></div>
			<div><dt>Date range</dt><dd>{o.dates.min ?? '—'} to {o.dates.max ?? '—'}{o.dates.undated ? ` (${n(o.dates.undated)} undated)` : ''}</dd></div>
			<div><dt>Originals verified at import</dt><dd>{n(o.originals.verified)}{o.originals.missing ? ` (${n(o.originals.missing)} missing)` : ''}</dd></div>
		</dl>
		<h3>Documents by bundle</h3>
		<ul data-tally="bundle">{#each sorted(o.byBundle) as [k, v], i (i)}<li>{revealInvisible(k)}: {n(v)}</li>{/each}</ul>
	</section>

	<section aria-labelledby="documents-title" data-preview-section="documents">
		<h2 id="documents-title">Original documents</h2>
		{#if data.originals.length}
			<ul>
				{#each data.originals as x (x.ref)}
					<li data-ref={x.ref} data-asset-id={x.assetId}>{revealInvisible(x.ref)} — {displayFilename(x.path)} ({x.mediaType}, {n(x.size)} bytes)
						{#if x.viewHref}<a data-action="view-original" href={x.viewHref}>View PDF</a>{/if}
						<a data-action="download-original" href={x.downloadHref}>Download</a></li>
				{/each}
			</ul>
		{:else}
			<p>The link maps no uploaded original.</p>
		{/if}
		{#if data.unavailable.length}
			<h3>Declared but unavailable</h3>
			<p>These originals are named by the package but were not uploaded (or are embedded in another document). There is no file to open.</p>
			<ul data-unavailable-originals={data.unavailable.length}>
				{#each data.unavailable as u (u.ref)}
					<li data-ref={u.ref} data-unavailable={u.kind}>{revealInvisible(u.ref)} — {u.kind === 'missing' ? `missing: ${displayFilename(u.path)}` : `embedded in ${revealInvisible(u.parentRef)}`}</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="chronology-title" data-preview-section="chronology">
		<h2 id="chronology-title">Chronology</h2>
		<form class="filters" role="search" aria-label="Filter the chronology" method="GET">
			<label>Text, ref or filename<br /><input name="q" value={c.query.q} /></label>
			<label>Bundle<br /><select name="bundle" value={c.query.bundle}><option value="">All bundles</option>{#each c.options.bundles as b (b)}<option value={b}>{revealInvisible(b)}</option>{/each}</select></label>
			<label>Type<br /><select name="type" value={c.query.type}><option value="">All types</option>{#each c.options.types as t (t)}<option value={t}>{revealInvisible(t)}</option>{/each}</select></label>
			<label>Text status<br /><select name="status" value={c.query.status}><option value="">Any text status</option>{#each c.options.statuses as s (s)}<option value={s}>{revealInvisible(s)}</option>{/each}</select></label>
			<button type="submit">Search</button>
			<span role="status" aria-live="polite" data-count={c.items.length}>{n(c.items.length)} of {n(c.total)} documents</span>
		</form>
		<table aria-label="Chronology">
			<thead><tr><th scope="col">Date</th><th scope="col">Ref</th><th scope="col">Title / subject</th><th scope="col">Type</th><th scope="col">Bundle</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Original</th></tr></thead>
			<tbody>
				{#each c.items as r (r.ref)}
					<tr data-ref={r.ref}>
						<td>{r.date || 'undated'}</td>
						<td>{revealInvisible(r.ref)}{#if r.parentRef}<small> in {revealInvisible(r.parentRef)}</small>{/if}</td>
						<td>{revealInvisible(r.title)}{#if r.sender}<small> — {revealInvisible(r.sender)}</small>{/if}{#if r.excerpt}<br /><small>{revealInvisible(excerptPreview(r.excerpt))}</small>{/if}</td>
						<td>{revealInvisible(r.docType)}</td>
						<td>{revealInvisible(r.bundle)}</td>
						<td>{money(r.amount)}</td>
						<td>{statusLabel(r.textStatus)}</td>
						<td>{#if r.downloadHref}{#if r.viewHref}<a data-action="view-original" data-asset-id={r.assetId} href={r.viewHref}>view</a> · {/if}<a data-action="download-original" data-asset-id={r.assetId} href={r.downloadHref}>download</a>{:else}<span data-file={r.file}>{r.file === 'present' ? 'not linked' : r.file}</span>{/if}</td>
					</tr>
				{:else}
					<tr><td colspan="8">No documents match these filters.</td></tr>
				{/each}
			</tbody>
		</table>
	</section>
</main>

<style>
	main { max-width: 80rem; margin: 1rem auto; padding: 1rem; }
	header.private { border: .25rem solid var(--danger); border-radius: var(--radius); padding: .5rem 1rem; }
	header.private h1 { color: var(--danger); margin-block: .3rem; }
	dl div { display: flex; gap: .5rem; }
	dt { font-weight: 600; }
	code { white-space: pre-wrap; overflow-wrap: anywhere; }
	table { border-collapse: collapse; width: 100%; }
	th, td { border-bottom: 1px solid var(--border); padding: .3rem; text-align: left; vertical-align: top; }
</style>
