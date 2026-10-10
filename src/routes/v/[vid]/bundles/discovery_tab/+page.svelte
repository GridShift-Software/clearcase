<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import { NOT_SERVED } from '$lib/views/bundles/links';
	import { downloadBlob } from '$lib/views/bundles/download';
	import { ds, type Op } from '$lib/views/bundles/state.svelte';
	import { postAction } from '$lib/views/bundles/post';
	import { NO_DOCUMENT, bundleHTML, coverDoc, fileCo, filterItems, incompleteNotes, isUnmatched, scheduleCounts, schedLabel, selectedFiles, type CO, type Mode, type ScheduleItem } from '$lib/views/bundles/discovery';
	let { data } = $props();
	const vid = $derived(data.version.id);
	// local copies of the stored user work: the page shows what the user did at once and saves it in the background
	let mode = $state<Mode>(untrack(() => data.mode));
	const sel = new SvelteSet<string>(untrack(() => data.selected));
	const marks = new SvelteMap<string, CO>(untrack(() => data.marks));
	const meta = $derived(data.meta[mode]);
	const items = $derived(data.schedules[mode]);
	const counts = $derived(scheduleCounts(items));
	const shown = $derived(filterItems(items, ds.q, ds.onlyMissing));
	const files = $derived(selectedFiles(data.schedules, sel, marks));
	const notes = $derived(incompleteNotes(files, sel));
	const label = (m: Mode) => data.meta[m].label ?? (m === 'discovery' ? 'Discovery schedule' : 'Supplementary schedule');

	// one write at a time, in order; a failed write is kept for Retry and shown, and the page keeps the user's state
	let failed = $state<Op[]>([]);
	let error = $state<string | null>(null);
	let pending = $state(0);
	let notice = $state<string | null>(null);
	let chain: Promise<void> = Promise.resolve();
	const send = (ops: Op[]) => {
		pending += ops.length;
		chain = chain.then(async () => {
			for (const op of ops) {
				const r = failed.length ? { ok: false as const, message: error ?? 'Not saved.' } : await postAction(op.action, op.entries);
				pending--;
				if (!r.ok) { failed = [...failed, op]; error = r.message; }
			}
		});
	};
	const retry = () => { const ops = failed; failed = []; error = null; send(ops); };
	const keysOf = (ks: Iterable<string>): [string, string][] => [...ks].map((k) => ['key', k]);

	const toggleFile = (key: string, on: boolean) => { if (on) sel.add(key); else sel.delete(key); send([{ action: 'select', entries: [['on', on ? '1' : '0'], ...keysOf([key])] }]); };
	const toggleItem = (i: ScheduleItem, on: boolean) => { for (const f of i.files) if (on) sel.add(f.key); else sel.delete(f.key); send([{ action: 'select', entries: [['on', on ? '1' : '0'], ...keysOf(i.files.map((f) => f.key))] }]); };
	const setCo = (key: string, v: CO) => { marks.set(key, v); send([{ action: 'co', entries: [['val', v], ...keysOf([key])] }]); };
	const markSel = (v: CO) => {
		if (!sel.size) { notice = 'Select one or more documents first (tick the file checkboxes).'; return; }
		notice = null;
		for (const k of sel) marks.set(k, v);
		send([{ action: 'co', entries: [['val', v], ...keysOf(sel)] }]);
	};
	const clearSel = () => { sel.clear(); send([{ action: 'clear', entries: [] }]); };
	const switchMode = (m: Mode) => { mode = m; ds.q = ''; ds.onlyMissing = false; send([{ action: 'mode', entries: [['mode', m]] }]); };
	const removeKey = (key: string) => toggleFile(key, false);

	// S-discovery_tab-1 corrected: each control has exactly one handler, so one click is one action after any number of
	// visits and mode switches.
	const coverFile = () => `${meta.file ?? 'Schedule (cover)'}.html`;
	const cover = () => coverDoc(data.caption, meta, items, marks);
	const coverDownload = () => downloadBlob(coverFile(), cover(), 'text/html');
	const coverOpen = () => {
		const w = window.open('', '_blank');
		if (!w) { coverDownload(); return; }
		w.document.write(cover());
		w.document.close();
		w.focus();
		setTimeout(() => { try { w.print(); } catch { /* the popup was closed */ } }, 350);
	};
	const indexDownload = () => downloadBlob(`${data.caption.bundleIndexName ?? 'Court Bundle Index'}.html`, bundleHTML(data.caption, files, notes), 'text/html');
	let printing = $state(false);
	const printIndex = () => {
		printing = true;
		const done = () => { printing = false; window.removeEventListener('afterprint', done); };
		window.addEventListener('afterprint', done);
		setTimeout(() => { window.print(); setTimeout(done, 1500); }, 60);
	};

	let filterTimer: ReturnType<typeof setTimeout> | undefined;
	let qInput = $state(ds.q);
	const filter = (v: string) => { qInput = v; clearTimeout(filterTimer); filterTimer = setTimeout(() => { ds.q = v; }, 140); };
	$effect(() => { qInput = ds.q; });

	let ready = $state(false);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready={ready ? 'discovery_tab' : null} data-pending={pending} class:ds-printing={printing}>
	<PageHeader heading="Discovery Schedule" section="Discovery Schedule" caseName={data.version.titleName} subtitle="Each affidavit schedule reproduced and linked to the discovered file(s) on disk · open in-app · download · court bundle · Copy/Original" />
	{#if error}<p class="error" role="alert" id="ds-error">{error} <button type="button" id="ds-retry" onclick={retry}>Retry</button></p>{/if}
	{#if notice}<p class="notice" role="status" id="ds-notice">{notice}</p>{/if}
	{#if !data.present}
		<p class="empty">This results version has no discovery schedules.</p>
	{:else if ds.view === 'bundle'}
		<section aria-labelledby="ds-bundle-h" id="ds-bundle">
			<h2 id="ds-bundle-h">Court Bundle</h2>
			<p class="sub">{files.length} document{files.length === 1 ? '' : 's'} selected · assembled in schedule &amp; item order <button type="button" class="ds-btn" id="ds-back" onclick={() => { ds.view = 'schedule'; }}>◂ Back to schedule</button></p>
			<div class="ds-bar"><span class="cnt"><b id="ds-bundle-count">{files.length}</b> documents in this bundle</span><span class="sp"></span><button type="button" class="ds-btn pri" id="ds-print" onclick={printIndex}>Print / Save as PDF (index)</button><button type="button" class="ds-btn" id="ds-dlindex" onclick={indexDownload}>Download index (HTML)</button><button type="button" class="ds-btn" id="ds-empty" onclick={clearSel}>Empty bundle</button></div>
			{#if notes.length}<p class="warning" id="ds-incomplete"><b>Incomplete selection</b>: {notes.join('; ')}.</p>{/if}
			{#if !files.length}
				<div class="card"><div class="empty">No documents selected. Go back and tick documents, then Build court bundle.</div></div>
			{:else}
				<table class="ds-tbl" id="ds-bundle-table"><thead><tr><th>#</th><th>Schedule</th><th>Item</th><th>Document</th><th>Date</th><th>C/O</th><th>Action</th></tr></thead><tbody>
					{#each files as f, idx (`${f.schedule}-${f.no}-${f.key}`)}
						<tr data-key={f.key}><td class="ds-no">{idx + 1}</td><td>{schedLabel(f.schedule)}</td><td class="ds-no">{f.no}.</td><td><div class="b">{f.desc}</div><div class="fn">{f.fn}</div></td><td class="ds-date">{f.date || ''}</td><td class={f.co === 'O' ? 'co-o' : 'co-c'}>{f.co}</td><td>{#if f.ref}<CitationLink resultsVersion={vid} ref={f.ref} label="Open" /><CitationLink resultsVersion={vid} ref={f.ref} label="Download" />{:else}<span class="not-served">{NOT_SERVED}</span>{/if}<button type="button" class="rm" onclick={() => removeKey(f.key)}>Remove</button></td></tr>
					{/each}
				</tbody></table>
			{/if}
		</section>
		<section class="print-only" aria-hidden="true" id="ds-print-area">
			<h2>{data.caption.plaintiff ?? ''} v {data.caption.defendant ?? ''}</h2>
			<div class="cap">{data.caption.court ?? ''} {data.caption.division ?? ''} · {data.caption.caseNumber ?? ''}<br /><b>COURT BUNDLE — INDEX OF DOCUMENTS</b> ({files.length} documents)</div>
			{#if notes.length}<div class="cap"><b>INCOMPLETE SELECTION</b>: {notes.join('; ')}.</div>{/if}
			<table><thead><tr><th>#</th><th>Item</th><th>Description</th><th>Date</th><th>Document</th><th>C/O</th></tr></thead><tbody>
				{#each files as f, idx (`p-${f.schedule}-${f.no}-${f.key}`)}
					{#if idx === 0 || files[idx - 1]!.schedule !== f.schedule}<tr class="sec"><td colspan="6">{schedLabel(f.schedule)}</td></tr>{/if}
					<tr><td>{idx + 1}</td><td>{f.no}.</td><td>{f.desc}</td><td>{f.date || ''}</td><td>{f.fn}{f.ref ? '' : ` [${NOT_SERVED.toUpperCase()}]`}</td><td>{f.co}</td></tr>
				{/each}
			</tbody></table>
		</section>
	{:else}
		<div class="ds-switch" role="group" aria-label="Schedule">
			{#each ['discovery', 'supplementary'] as const as m (m)}<button type="button" class:on={mode === m} aria-pressed={mode === m} data-mode={m} onclick={() => switchMode(m)}>{label(m)}</button>{/each}
		</div>
		<div class="ds-bar">
			<input class="ds-in" id="ds-q" placeholder="Filter item, description or file…" value={qInput} oninput={(e) => filter(e.currentTarget.value)} />
			<label class="ds-btn"><input type="checkbox" id="ds-missing" checked={ds.onlyMissing} onchange={(e) => { ds.onlyMissing = e.currentTarget.checked; }} />Only unmatched ({counts.unmatched})</label>
			<span class="sp"></span>
			<span class="cnt"><b id="ds-count">{sel.size}</b> selected</span>
			<button type="button" class="ds-btn" id="ds-mark-c" onclick={() => markSel('C')}>Mark Copy</button>
			<button type="button" class="ds-btn" id="ds-mark-o" onclick={() => markSel('O')}>Mark Original</button>
			<button type="button" class="ds-btn" id="ds-clear" onclick={clearSel}>Clear</button>
			<button type="button" class="ds-btn pri" id="ds-build" onclick={() => { ds.view = 'bundle'; }}>Build court bundle ▸</button>
		</div>
		<div class="ds-bar">
			<span class="cnt" id="ds-info">{#if meta.deed}<b>{meta.deed}</b> · {/if}{#if meta.schedule}{meta.schedule} · {/if}{counts.items} items · {counts.files} files linked{counts.notServed ? ` · ${counts.notServed} not in the verified index` : ''} · uncertified</span>
			<span class="sp"></span>
			<button type="button" class="ds-btn" id="ds-cover-open" onclick={coverOpen}>Open / print cover page</button>
			<button type="button" class="ds-btn" id="ds-cover-dl" onclick={coverDownload}>Download cover page (uncertified)</button>
		</div>
		<div id="ds-list">
			<table class="ds-tbl"><thead><tr><th></th><th>Item</th><th>Document(s) &amp; description</th><th>Date</th></tr></thead><tbody>
				{#if !shown.length}<tr><td colspan="4" class="none">No items match.</td></tr>{/if}
				{#each shown as i (`${mode}-${i.no}`)}
					{@const anySel = i.files.some((f) => sel.has(f.key))}
					{@const allSel = i.files.length > 0 && i.files.every((f) => sel.has(f.key))}
					<tr class:sel={anySel} data-item="{mode}-{i.no}"><td>{#if i.files.length}<input type="checkbox" checked={allSel} title="Select all files in this item" aria-label="Select all files in item {i.no}" onchange={(e) => toggleItem(i, e.currentTarget.checked)} />{/if}</td><td class="ds-no">{i.no}.</td><td class="ds-desc"><div class="tx">{i.desc || '—'}</div>{#if i.files.length}<div class="ds-files">{#each i.files as f, j (j)}{@const c = fileCo(f, marks)}<div class="ds-chip" class:xref={!!f.x} data-key={f.key}><input type="checkbox" checked={sel.has(f.key)} aria-label="Select {f.fn}" onchange={(e) => toggleFile(f.key, e.currentTarget.checked)} /><span class="fn" title={f.fn}>{f.fn}</span>{#if f.x}<span class="ds-x" title={f.x}>↪ {f.x}</span>{/if}<span class="ds-co"><button type="button" class:on-c={c === 'C'} aria-pressed={c === 'C'} aria-label="Copy" onclick={() => setCo(f.key, 'C')}>C</button><button type="button" class:on-o={c === 'O'} aria-pressed={c === 'O'} aria-label="Original" onclick={() => setCo(f.key, 'O')}>O</button></span>{#if f.ref}<CitationLink resultsVersion={vid} ref={f.ref} label="Open" /><CitationLink resultsVersion={vid} ref={f.ref} label="Download" />{:else}<span class="not-served">{NOT_SERVED}</span>{/if}</div>{/each}</div>{:else if isUnmatched(i)}<div class="ds-none">{NO_DOCUMENT}</div>{/if}</td><td class="ds-date">{i.date || ''}</td></tr>
				{/each}
			</tbody></table>
		</div>
	{/if}
</main>

<style>
	.ds-switch { display: flex; gap: 6px; margin: 0 0 10px; }
	.ds-switch button.on { font-weight: 700; text-decoration: underline; }
	.ds-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
	.ds-bar .sp { flex: 1; }
	.ds-in { min-width: 260px; }
	.ds-tbl { width: 100%; border-collapse: collapse; }
	.ds-tbl td, .ds-tbl th { border-bottom: 1px solid #ddd; padding: 4px 6px; vertical-align: top; text-align: left; }
	.ds-tbl tr.sel { background: #eef4ff; }
	.ds-chip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 3px 0; font-size: 0.9em; }
	.ds-chip.xref { border: 1px dashed #888; padding: 2px; }
	.ds-co button { padding: 0 6px; }
	.ds-co .on-c { background: #1d4ed8; color: #fff; }
	.ds-co .on-o { background: #15803d; color: #fff; }
	.ds-chip :global(a) { margin-left: 4px; }
	.not-served, .ds-none { color: #92400e; font-style: italic; }
	.none { text-align: center; padding: 22px; }
	.co-o { color: #15803d; font-weight: 700; text-align: center; }
	.co-c { color: #1d4ed8; font-weight: 700; text-align: center; }
	.fn { font-family: ui-monospace, monospace; font-size: 0.85em; }
	.error { color: #b91c1c; }
	.warning { color: #92400e; }
	.print-only { display: none; }
	@media print {
		main.ds-printing > :global(*:not(#ds-print-area)) { display: none !important; }
		main.ds-printing #ds-print-area { display: block; }
		:global(body:has(main.ds-printing) nav) { display: none !important; }
	}
</style>
