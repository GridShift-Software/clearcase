<script lang="ts">
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import { revealInvisible } from './display';
	import type { OverviewData } from './model';
	// The hosted overview of the case's current published version: the derived counts and stored overview the local
	// Overview shows, as plain text. It certifies nothing about the other views.
	let { overview: o }: { overview: OverviewData } = $props();
	const sorted = (m: [string, number][]) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const n = (x: number) => x.toLocaleString('en');
</script>

<section class="overview" aria-labelledby="overview-title" data-overview-state="published" data-results-version={o.resultsVersion}>
	<h2 id="overview-title">Overview</h2>
	<p data-overview-subtitle>{revealInvisible(o.subtitle ?? o.matterTitle ?? o.caseName)}</p>
	<DegradedRows failed={o.documents.failed} />
	<p><small>Results version <code title={o.resultsVersion}>{o.resultsVersion.slice(0, 19)}…</code> · produced {revealInvisible(o.created)} by {revealInvisible(o.producer)} from {revealInvisible(o.inputKind)} input.</small></p>
	<dl class="kpis">
		<div><dt>Documents indexed</dt><dd id="count-documents" data-count={o.documents.total}>{n(o.documents.total)}</dd></div>
		<div><dt>Invoices</dt><dd id="count-invoices">{n(o.counts.invoices)}</dd></div>
		<div><dt>Emails</dt><dd>{n(o.counts.emails)}</dd></div>
		<div><dt>Without extracted text</dt><dd id="count-text-none">{n(o.counts.withoutText)}</dd></div>
		<div><dt>Date range</dt><dd>{o.dates.min ?? '—'} to {o.dates.max ?? '—'}{o.dates.undated ? ` (${n(o.dates.undated)} undated)` : ''}</dd></div>
		<div><dt>Originals verified</dt><dd>{n(o.originals.verified)}{o.originals.missing ? ` (${n(o.originals.missing)} missing)` : ''}</dd></div>
	</dl>
	<h3>Documents by bundle</h3>
	<ul data-tally="bundle">{#each sorted(o.tallies.byBundle) as [k, v], i (i)}<li>{revealInvisible(k)}: {n(v)}</li>{/each}</ul>
	<p><a data-action="open-chronology" href={o.chronologyHref}>Chronology</a> · <a data-action="open-notes" href={o.notesHref}>Your notes</a></p>
</section>
