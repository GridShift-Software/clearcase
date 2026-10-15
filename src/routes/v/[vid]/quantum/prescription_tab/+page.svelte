<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate, replaceState } from '$app/navigation';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import Narrative from '$lib/components/Narrative.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { download } from '$lib/components/csv';
	import Kpi from '$lib/views/quantum/Kpi.svelte';
	import { arithmetic, AS_OF_TEXT, asOfStatus, filterRows, paginate, paramsFrom, prescriptionCsv, queryFrom, RELIES, riskOptions, summaryCheck, urlNotes, type PrescQuery } from '$lib/views/quantum/prescription';
	import '$lib/views/quantum/quantum.css';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const vid = $derived(data.version.id);
	const known = $derived(new Set(data.known));
	type State = { prescription?: string };
	let ready = $state(false);
	const risks = $derived(riskOptions(data.rows));
	const fromUrl = () => new URLSearchParams((page.state as State).prescription ?? page.url.search);
	let query = $state<PrescQuery>(queryFrom(untrack(fromUrl), untrack(() => risks)));
	let notes = $state<string[]>([]);
	afterNavigate(() => {
		const p = new URLSearchParams(page.url.search);
		query = queryFrom(p, risks);
		notes = urlNotes(p, risks, paginate(filterRows(data.rows, query), query.page).pages);
	});
	const sync = () => {
		notes = [];
		const p = paramsFrom(query).toString();
		if (p !== new URLSearchParams(location.search).toString()) replaceState(`${page.url.pathname}${p ? `?${p}` : ''}`, { prescription: p } satisfies State as unknown as App.PageState);
	};
	const set = (k: 'q' | 'risk', v: string) => { query = { ...query, [k]: v, page: 1 }; sync(); };
	const go = (d: number) => { query = { ...query, page: pg.page + d }; sync(); };
	const shown = $derived(filterRows(data.rows, query));
	const pg = $derived(paginate(shown, query.page));
	const ssrNotes = $derived(ready ? notes : urlNotes(fromUrl(), risks, pg.pages));
	const arith = $derived(arithmetic(data.rows, data.asOf));
	const check = $derived(data.summary ? summaryCheck(data.summary, data.rows) : null);
	const summaryFlag = $derived(data.summary && check ? ['The imported summary differs from the rows.',
		check.totalMatches ? '' : `It tracks ${data.summary.total} invoices where the list has ${data.rows.length}.`,
		check.reliesMatches ? '' : `It counts ${data.summary.reliesOnInterruption} relying on interruption where ${check.reliesCount} rows carry that label.`,
		'The imported figures are shown as given.'].filter(Boolean).join(' ') : '');
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="prescription_tab" data-hydrated={ready ? '1' : null}>
	<PageHeader heading="Prescription" section="Prescription" caseName={data.version.titleName} subtitle="Three-year extinctive prescription per invoice, and what interrupts it">
		{#snippet actions()}<button type="button" id="export-presc" onclick={() => download(data.exportName.name, prescriptionCsv(shown))}>Export CSV</button>{#if data.exportName.note}<span class="export-note" data-export-note>{data.exportName.note}</span>{/if}{/snippet}
	</PageHeader>
	{#if data.summary}
		<div class="q-kpis">
			<Kpi label="Invoices tracked" value={String(data.summary.total)} />
			<Kpi label="Rely on interruption" value={String(data.summary.reliesOnInterruption)} sub="3-yr window has closed" />
			<Kpi label="Key interruption" value="Award {data.summary.awardDate}" sub="+ acknowledgements & service" />
		</div>
		{#if check && (!check.totalMatches || !check.reliesMatches)}
			<div class="q-flag" role="note" id="summary-flag">{summaryFlag}</div>
		{/if}
	{/if}
	{#if data.note}
		<div class="q-card">
			<Narrative text={data.note} resultsVersion={vid} known={data.noteKnown} />
			<p class="q-note" id="note-imported">Imported narrative: not checked against the computed dates.</p>
		</div>
	{/if}
	<div class="q-card">
		<form method="GET" id="pr-form" class="q-row">
			<input id="pr-q" name="q" aria-label="Filter invoice / ref" placeholder="Filter invoice / ref" value={query.q} oninput={(e) => set('q', e.currentTarget.value)} class="q-filter" />
			<select id="pr-risk" name="risk" aria-label="Risk" value={query.risk} onchange={(e) => set('risk', e.currentTarget.value)}><option value="">Any risk</option>{#each risks as r (r)}<option value={r}>{r}</option>{/each}</select>
			<button id="pr-apply" hidden={ready}>Apply filter</button>
		</form>
		{#if ssrNotes.length}<div class="q-flag" role="note" id="pr-url-note">{#each ssrNotes as n (n)}<p>{n}</p>{/each}</div>{/if}
		<TableScroll label="Prescription" class="q-wrap">
			<table class="q-tbl" id="prescription">
				<thead><tr><th>Ref</th><th>Invoice</th><th>Invoice date</th><th>Prescribes (3yr)</th><th>Risk</th><th>As-of status</th><th>Doc</th></tr></thead>
				<tbody>
					{#each pg.slice as r, i (`${r.ref}#${i}`)}
						{@const st = asOfStatus(r, data.asOf)}
						<tr data-ref={r.ref}>
							<td class="mono">{r.ref}</td><td class="mono">{r.no}</td><td class="mono">{r.date}</td><td class="mono">{r.prescDate}</td>
							<td><span class={r.risk === RELIES ? 'chip warn' : 'chip ok'}>{r.risk}</span></td>
							<td><span title="as of {data.asOf}, arithmetic only" data-as-of={st}>{AS_OF_TEXT[st]}</span></td>
							<td><CitationLink resultsVersion={vid} ref={r.ref} exists={known.has(r.ref)} label={known.has(r.ref) ? 'open ↗' : r.ref} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
			<div class="pager q-pager" id="pr-pager"><button type="submit" form="pr-form" name="page" value={pg.page - 1} disabled={pg.page <= 1} onclick={(e) => { e.preventDefault(); go(-1); }}>Prev</button><span>Page {pg.page} / {pg.pages}</span><button type="submit" form="pr-form" name="page" value={pg.page + 1} disabled={pg.page >= pg.pages} onclick={(e) => { e.preventDefault(); go(1); }}>Next</button><span class="count q-push">Showing {pg.from}–{pg.to} of {pg.total.toLocaleString('en')}</span></div>
		</TableScroll>
	</div>
	<div class="q-card" id="presc-arithmetic">
		<h3>Arithmetic checks</h3>
		<p id="arith-plus3">{arith.plusThree} of {arith.rows} imported prescription dates are the invoice date plus 3 calendar years.{arith.leapInvoices ? ` ${arith.leapInvoices} invoices are dated 29 February; ${arith.leapMovedTo28} of them prescribe on 28 February.` : ''}</p>
		<p id="arith-asof">{arith.passed} of {arith.rows} rows have a prescription date before the as-of date {arith.asOf} (today, South African time).</p>
		<p class="q-note" id="arith-caution">Arithmetic only; legal rule (interruption) not approved. The Prescribes (3yr) and Risk columns are imported as given; the risk labels were classified against the headline date {data.headlineDate || '(not in this package)'}, not against the as-of date.</p>
	</div>
</main>
