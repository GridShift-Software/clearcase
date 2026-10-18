<script lang="ts">
	import { onMount } from 'svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import OverviewSlots from '$lib/components/OverviewSlots.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import { money, plural } from '$lib/components/format';
	import { grouped, viewHref, blockedBy } from '$lib/components/views';
	let { data, form } = $props();
	const o = $derived(data.overview);
	const c = $derived(o.counts);
	const vid = $derived(data.version.id);
	const t = $derived(data.tallies);
	const sorted = (m: [string, number][]) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const claim = (k: string) => t.claims.find(([x]) => x === k)?.[1] ?? null;
	const count = (m: [string, number][], k: string) => m.find(([x]) => x === k)?.[1] ?? 0;
	const beside = (k: string, n: number) => { const x = claim(k); return x !== null && String(x) !== String(n) ? ` (the source claims ${x})` : ''; };
	const content = $derived(data.content);
	let ready = $state(false);
	onMount(() => { ready = true; performance.mark('cc-ready'); });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'overview' : null}>
	<PageHeader heading="Overview" section="Overview" caseName={data.version.titleName} subtitle={content.subtitle ?? (o.matter?.title || data.version.caseName)} />
	<DegradedRows failed={data.documents.failed} />
	<p>Results version <code title={vid}>{vid.slice(0, 19)}…</code> · produced {o.created} by {o.producer} from {o.inputKind} input.</p>
	{#if data.previous}
		<form method="POST" action="?/rollback" id="rollback-form">
			<input type="hidden" name="expect" value={vid} />
			<input type="hidden" name="to" value={data.previous} />
			<button id="rollback">Return to the previously active version</button> <small><code>{data.previous.slice(0, 19)}…</code></small>
		</form>
	{/if}
	{#if form?.message}<p class="error" role="alert" id="rollback-error">{form.message}</p>{/if}

	<div class="grid kpi-grid">
		<section class="card" aria-labelledby="kpi-docs"><h2 id="kpi-docs">Documents indexed</h2>
			<p class="num" id="count-documents" data-count={data.documents.total}>{data.documents.total.toLocaleString('en')}</p>
			<p><small>{content.kpiDocumentsNote ? `${content.kpiDocumentsNote} (source caption) · ` : ''}Counted from the validated register{data.documents.provided ? ` (${data.documents.imported.toLocaleString('en')}) plus ${plural(data.documents.provided, 'row')} from document-row providers` : ''}{claim('docCount') !== null ? `; the source claims ${claim('docCount')}` : ''}. {plural(t.byBundle.length, 'bundle')}.</small></p></section>
		<section class="card" aria-labelledby="kpi-due"><h2 id="kpi-due">Amount due (to date)</h2>
			{#if o.quantum}<p class="num" id="amount-due">{money(o.quantum.headlineDue) || '—'}</p><p><small>{o.quantum.headlineRef}{o.quantum.headlineDate ? ` · as at ${o.quantum.headlineDate}` : ''} (source value)</small></p>{:else}<p>Not in this package.</p>{/if}</section>
		<section class="card" aria-labelledby="kpi-inv"><h2 id="kpi-inv">Invoices</h2><p class="num" id="count-invoices">{(o.quantum?.invoiceCount ?? c.invoices).toLocaleString('en')}</p><p><small>{content.kpiInvoicesNote ? `${content.kpiInvoicesNote} (source caption) · ` : ''}{c.invoices.toLocaleString('en')} register rows of type invoice</small></p></section>
		<section class="card" aria-labelledby="kpi-contra"><h2 id="kpi-contra">Contradiction flags</h2>
			{#if o.contradictions}<p class="num">{o.contradictions.total}</p><p><small>{o.contradictions.highCount} high-severity</small></p>{:else}<p>Not in this package.</p>{/if}</section>
		<section class="card" aria-labelledby="kpi-scan"><h2 id="kpi-scan">Without extracted text</h2><p class="num" id="count-text-none">{count(t.byTextStatus, 'none').toLocaleString('en')}</p>
			<p><small>Register rows with text status none{claim('textNone') !== null ? `; the source claims ${claim('textNone')}` : ''}.</small></p></section>
		<OverviewSlots slots={data.slots} ctx={{ caseId: data.version.caseId, caseName: data.version.caseName, resultsVersion: vid }} />
		<section class="card" aria-labelledby="kpi-orig"><h2 id="kpi-orig">Originals</h2>
			<table><tbody>
				<tr><td>Verified in the case folder</td><td class="num" id="count-verified">{o.originals.verified + o.originals.caseMismatch}</td></tr>
				<tr><td>Missing</td><td class="num" id="count-missing">{o.originals.missing}</td></tr>
				<tr><td>Inside a parent e-mail</td><td class="num">{o.originals.embedded}</td></tr>
				<tr><td>Download only (content contradicts type)</td><td class="num">{o.originals.downloadOnly}</td></tr>
			</tbody></table>
			<p id="originals-checked"><small>Checked when this version was imported, <time datetime={data.originalsCheckedAt}>{data.originalsCheckedAt}</time>. A document page checks its original again when it is opened.</small></p></section>
		<section class="card" aria-labelledby="kpi-notes"><h2 id="kpi-notes">My notes</h2>
			<p id="notes-total">{plural(data.notes.total, 'note')} for this case: {data.notes.here + data.notes.exact} on documents of this version{data.notes.ambiguous ? `, ${data.notes.ambiguous} ambiguous` : ''}{data.notes.missing + data.notes.unanchored ? `, ${data.notes.missing + data.notes.unanchored} detached (their document is not in this version)` : ''}.</p>
			<ul>{#each data.notes.byRef.slice(0, 20) as n (n.ref)}<li><CitationLink resultsVersion={vid} ref={n.ref} />: {n.n}{n.status === 'ambiguous' ? ' (ambiguous)' : ''}</li>{/each}</ul></section>
	</div>

	{#if data.narrative}
		<section class="card narr" aria-labelledby="matter-heading"><h2 id="matter-heading">The matter, in one paragraph</h2><Narrative text={data.narrative} resultsVersion={vid} known={data.known} /></section>
	{/if}

	<section class="card" aria-labelledby="dates-heading"><h2 id="dates-heading">Dates</h2>
		<p id="date-span">Date span: <b>{o.dates.min ?? '—'}</b> → <b>{o.dates.max ?? '—'}</b> · {c.emails} emails{beside('emails', c.emails)}{c.people !== null ? ` · ${c.people} correspondents${beside('people', c.people)}` : ''}</p>
		<p id="undated-note">{plural(o.dates.undated, 'document')} undated. Dates are shown as the source gives them; {data.dateBasisKnown ? 'the chronology\'s Date basis column says what kind of date each one is where the source supplies it' : 'their basis (issue, sent, received) is not supplied by this package'}.</p></section>

	<div class="grid">
		{#each [['By bundle', t.byBundle], ['By type', t.byDocType], ['By text status', t.byTextStatus]] as const as [title, m] (title)}
			<section class="card"><h2>{title}</h2><table><tbody>
				{#each sorted(m) as [k, n] (k)}<tr><td>{k || '(empty)'}</td><td class="num">{n}</td></tr>{/each}
			</tbody></table></section>
		{/each}
	</div>

	<section class="card" aria-labelledby="go-heading"><h2 id="go-heading">Go to</h2>
		<ul class="quick">{#each grouped() as g (g.group)}{#each g.views.filter((v) => ['chronology', 'matter', 'quantum_tab', 'documents', 'people', 'search', 'court_bundle_tab', 'rescan_tab'].includes(v.id)) as v (v.id)}<li><a href={viewHref(vid, v)}>{v.label}</a>{blockedBy(v) ? ` (not yet available, ${blockedBy(v)})` : ''}</li>{/each}{/each}</ul></section>

	{#if Object.keys(o.diagnostics).length}
		<details><summary>Validation totals for this version</summary><table><tbody>{#each Object.entries(o.diagnostics) as [k, n] (k)}<tr><td>{k}</td><td class="num">{n}</td></tr>{/each}</tbody></table></details>
	{/if}
</main>
