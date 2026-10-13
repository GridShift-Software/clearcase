<script lang="ts">
	import { onMount } from 'svelte';
	import { navigating } from '$app/state';
	import DegradedRows from '$lib/components/DegradedRows.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { n, statusLabel } from '$lib/views/evidence/common';
	import { MAX_CELLS } from '$lib/views/evidence/diff';
	let { data } = $props();
	const r = $derived(data.result);
	const cov = $derived(data.coverage);
	// the data is complete when the page renders (data-ready, also in the server's HTML); data-hydrated marks the
	// moment its controls respond
	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="hoa_diff_tab" data-hydrated={ready ? '1' : null} data-busy={navigating.to ? 'true' : null} data-result={r.kind}>
	<PageHeader heading="Document Diff" section="Document Diff" caseName={data.version.titleName} subtitle="Word- or line-level comparison of two documents (e.g. successive SLA drafts or invoice/statement versions)" />
	<DegradedRows failed={data.failed} />
	<form method="GET" class="card" aria-label="Choose two documents to compare" data-sveltekit-keepfocus data-sveltekit-noscroll>
		<div class="row">
			<div><label class="fld" for="diffA">Document A</label><select class="in" id="diffA" name="a" value={data.chosen.a}><option value="">— pick —</option>{#each data.candidates as c (c.ref)}<option value={c.ref}>{c.label}</option>{/each}</select></div>
			<div><label class="fld" for="diffB">Document B</label><select class="in" id="diffB" name="b" value={data.chosen.b}><option value="">— pick —</option>{#each data.candidates as c (c.ref)}<option value={c.ref}>{c.label}</option>{/each}</select></div>
			<div class="narrow"><label class="fld" for="diffmode">Mode</label><select class="in" id="diffmode" name="mode" value={data.chosen.mode}><option value="words">words</option><option value="lines">lines</option></select></div>
			<div class="narrow"><button id="diff-run">Compare</button></div>
		</div>
		<p class="tag">Compares the indexed text excerpts. For full-text diff, OCR/extract the full documents in a rebuild.</p>
		<p class="tag" id="diff-coverage" data-candidates={data.candidates.length} data-documents={cov.documents} data-max-excerpt={cov.maxExcerpt}>You choose the two documents; they are compared because you chose them, not because they are known versions of each other. {n(data.candidates.length)} of {n(cov.documents)} documents have an excerpt (at most {n(cov.maxExcerpt)} characters) and can be compared; {n(cov.documents - data.candidates.length)} cannot.{#if data.failed.length} Some documents are left out of these counts and cannot be chosen, because a document-row provider failed.{/if}</p>
	</form>
	{#if r.kind === 'pick'}
		<div class="card" id="diffOut"><div class="empty">Pick two documents.</div>{#each r.reasons as why, i (i)}<p class="warning diff-pick-reason">{why}</p>{/each}</div>
	{:else if r.kind === 'too-long'}
		<div class="card" id="diffOut" data-mode={r.mode}>
			<h3>{r.a.ref} vs {r.b.ref}</h3>
			<p class="coverage warning" id="diff-pair-coverage" data-too-long={r.cells}>Not compared: the excerpts of {r.a.ref} ({n(r.a.chars)} characters) and {r.b.ref} ({n(r.b.chars)} characters) are too long to compare here in {r.mode} mode ({n(r.cells)} token pairs; the limit is {n(MAX_CELLS)}).{r.mode === 'words' ? ' Try lines mode.' : ''}</p>
		</div>
	{:else if r.kind === 'diff'}
		<div class="card" id="diffOut" data-mode={r.mode}>
			<h3>{r.a.ref} vs {r.b.ref}</h3>
			<div class="tag files">{r.a.name}  ↔  {r.b.name}</div>
			<p class="coverage" id="diff-pair-coverage">Compared text: the excerpt of {r.a.ref} ({n(r.a.chars)} characters, text {statusLabel(r.a.textStatus)}) and of {r.b.ref} ({n(r.b.chars)} characters, text {statusLabel(r.b.textStatus)}), not the full documents.{r.same ? ' The same document is chosen twice.' : ''}</p>
			<div class="diff-body" id="diff-body">{#each r.segments as s, i (i)}{#if s.op === 'eq'}{s.text}{:else}<span class={s.op === 'del' ? 'diffdel' : 'diffadd'}>{s.text}</span>{/if}{/each}</div>
		</div>
	{/if}
</main>

<style>
	.row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; }
	/* a select takes the width of its longest option, so each cell may shrink below it and the select stops at its cell */
	.row > div { min-width: 0; max-width: 100%; }
	.row .in { max-width: min(28rem, 100%); }
	.fld { display: block; font-size: .85em; color: #555; }
	.tag, .coverage { color: #555; font-size: .9em; }
	.files { margin-bottom: .6rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	.diff-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
	.diffdel { background: #fde8e8; color: #7a1010; text-decoration: line-through; }
	.diffadd { background: #e3f4e3; color: #1d5b1d; }
	#diffOut { margin-top: 1rem; }
</style>
