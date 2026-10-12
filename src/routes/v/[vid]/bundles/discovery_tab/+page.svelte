<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { beforeNavigate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import { NOT_SERVED } from '$lib/views/bundles/links';
	import { downloadBlob } from '$lib/views/bundles/download';
	import { ds } from '$lib/views/bundles/state.svelte';
	import { postAction } from '$lib/views/bundles/post';
	import { chunkKeys, stillOwed, supersede, type Op } from '$lib/views/bundles/ops';
	import { NO_DOCUMENT, bundleHTML, coverDoc, fileCo, filterItems, incompleteNotes, isUnmatched, scheduleCounts, schedLabel, selectedFiles, type CO, type Mode, type ScheduleItem } from '$lib/views/bundles/discovery';
	let { data } = $props();
	const vid = $derived(data.version.id);
	// local copies of the stored user work: the page shows what the user did at once and saves it in the background
	let mode = $state<Mode>(untrack(() => data.mode));
	const sel = new SvelteSet<string>(untrack(() => data.selected));
	const marks = new SvelteMap<string, CO>(untrack(() => data.marks));
	// what this page last knew to be stored: a Copy/Original change sends it as its base, and Discard restores it
	const storedSel = new Set<string>(untrack(() => data.selected));
	const storedMarks = new Map<string, CO>(untrack(() => data.marks));
	let storedMode: Mode = untrack(() => data.mode);
	const meta = $derived(data.meta[mode]);
	const items = $derived(data.schedules[mode]);
	const counts = $derived(scheduleCounts(items));
	const shown = $derived(filterItems(items, ds.q, ds.onlyMissing));
	const files = $derived(selectedFiles(data.schedules, sel, marks));
	const notes = $derived(incompleteNotes(files, sel));
	const label = (m: Mode) => data.meta[m].label ?? (m === 'discovery' ? 'Discovery schedule' : 'Supplementary schedule');
	// item numbers the package repeats within this schedule: every row renders, and each repeat is flagged
	const repeated = $derived.by(() => { const seen = new Set<number>(), dup = new Set<number>(); for (const i of items) (seen.has(i.no) ? dup : seen).add(i.no); return dup; });

	// Writes go one at a time, in order (ops.ts). A failed op keeps its own error, Retry and Discard and never blocks a
	// later op; a later op on the same field of the same file takes that file out of the failed op. A large selection
	// is sent in chunks under the server's body limit.
	let queue: Op[] = [];
	let pending = $state(0);
	let failed = $state<Op[]>([]);
	let notice = $state<string | null>(null);
	let running = false, nextId = 0;
	const unsaved = $derived(new Set(failed.flatMap((o) => o.keys)));
	const nameOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);
	const coName = (v: string | null) => (v === 'O' ? 'Original' : v === 'C' ? 'Copy' : 'unmarked');
	const describe = (o: Op) => (o.action === 'mode' ? `switch to ${label(o.value as Mode)}` : `${o.action === 'co' ? `${coName(o.value)} on` : o.value === '1' ? 'tick' : 'untick'} ${o.keys.length} file${o.keys.length === 1 ? '' : 's'}`);
	const entriesOf = (o: Op): [string, string][] => (o.action === 'mode' ? [['mode', o.value]] : o.action === 'select' ? [['on', o.value], ...o.keys.map((k): [string, string] => ['key', k])]
		: [['val', o.value], ...o.keys.flatMap((k): [string, string][] => [['key', k], ['base', storedMarks.get(k) ?? '']])]);
	const stored = (o: Op, keys: Iterable<string>) => {
		if (o.action === 'mode') storedMode = o.value as Mode;
		else for (const k of keys) if (o.action === 'select') { if (o.value === '1') storedSel.add(k); else storedSel.delete(k); } else storedMarks.set(k, o.value as CO);
	};
	const pump = async () => {
		if (running) return;
		running = true;
		while (queue.length) {
			const op = queue[0]!;
			const r = await postAction(op.action, entriesOf(op));
			queue.shift();
			pending = queue.length;
			if (r.ok) { stored(op, op.keys); continue; }
			let owed: Op | null = op, why = r.message;
			const saved = r.data?.saved;
			if (Array.isArray(saved)) { const s = new Set(saved as string[]); stored(op, s); owed = { ...op, keys: op.keys.filter((k) => !s.has(k)) }; }
			const conflicts = r.data?.conflicts;
			if (Array.isArray(conflicts)) {
				for (const c of conflicts as { locator: string; stored: CO | null }[]) { if (c.stored) storedMarks.set(c.locator, c.stored); else storedMarks.delete(c.locator); }
				why += ' Stored now: ' + (conflicts as { locator: string; stored: CO | null }[]).slice(0, 3).map((c) => `${nameOf(c.locator)} is ${coName(c.stored)}`).join('; ') + (conflicts.length > 3 ? '; …' : '') + '.';
			}
			owed = owed && stillOwed(owed, queue);
			if (owed && (owed.action === 'mode' || owed.keys.length)) failed = [...failed, { ...owed, error: why }];
		}
		running = false;
	};
	const send = (o: Omit<Op, 'id'>) => {
		const op: Op = { ...o, id: ++nextId };
		failed = supersede(failed, op);
		for (const keys of op.action === 'mode' ? [[]] : chunkKeys(op.keys)) queue.push({ ...op, id: ++nextId, keys });
		pending = queue.length;
		void pump();
	};
	const retry = (o: Op) => { failed = failed.filter((x) => x.id !== o.id); send({ action: o.action, value: o.value, keys: o.keys }); };
	const retryAll = () => { const ops = failed; failed = []; for (const o of ops) send({ action: o.action, value: o.value, keys: o.keys }); };
	/** Drop a failed change: the page shows what is stored again for its files. */
	const discard = (o: Op) => {
		failed = failed.filter((x) => x.id !== o.id);
		if (o.action === 'mode') mode = storedMode;
		for (const k of o.keys) {
			if (o.action === 'select') { if (storedSel.has(k)) sel.add(k); else sel.delete(k); }
			else { const v = storedMarks.get(k); if (v) marks.set(k, v); else marks.delete(k); }
		}
	};

	const toggleFile = (key: string, on: boolean) => { if (on) sel.add(key); else sel.delete(key); send({ action: 'select', value: on ? '1' : '0', keys: [key] }); };
	const toggleItem = (i: ScheduleItem, on: boolean) => { for (const f of i.files) if (on) sel.add(f.key); else sel.delete(f.key); send({ action: 'select', value: on ? '1' : '0', keys: i.files.map((f) => f.key) }); };
	const setCo = (key: string, v: CO) => { marks.set(key, v); send({ action: 'co', value: v, keys: [key] }); };
	const markSel = (v: CO) => {
		if (!sel.size) { notice = 'Select one or more documents first (tick the file checkboxes).'; return; }
		notice = null;
		for (const k of sel) marks.set(k, v);
		send({ action: 'co', value: v, keys: [...sel] });
	};
	/** Clear and Empty bundle untick the files this page has selected (v5 keeps the marks). */
	const clearSel = () => { const keys = [...sel]; sel.clear(); if (keys.length) send({ action: 'select', value: '0', keys }); };
	const switchMode = (m: Mode) => { mode = m; ds.q = ''; ds.onlyMissing = false; send({ action: 'mode', value: m, keys: [] }); };
	const removeKey = (key: string) => toggleFile(key, false);

	// leaving with a failed or unsent change asks first; reload and close get the browser's own warning
	const unsavedCount = () => failed.length + Math.max(0, queue.length - (running ? 1 : 0));
	beforeNavigate((nav) => {
		if (!unsavedCount()) return;
		if (nav.type === 'leave' || !confirm('Some selection or Copy/Original changes are not saved. Leave this page and lose them?')) nav.cancel();
	});

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

	// without JavaScript nothing here can save or export, so every control renders disabled with a note until hydrated
	let ready = $state(false);
	const off = $derived(!ready);
	onMount(() => { ready = true; });
</script>

<main id="main" tabindex="-1" data-ready="discovery_tab" data-hydrated={ready ? '1' : null} data-pending={pending} data-unsaved={failed.length} aria-busy={pending > 0} class:ds-printing={printing}>
	<PageHeader heading="Discovery Schedule" section="Discovery Schedule" caseName={data.version.titleName} subtitle="Each affidavit schedule reproduced and linked to the discovered file(s) on disk · open in-app · download · court bundle · Copy/Original" />
	{#if off}<p class="notice" id="ds-nojs">Selecting, marking and the exports need JavaScript, which is off or still loading; nothing on this page can be saved without it.</p>{/if}
	{#if failed.length}<div class="error" role="alert" id="ds-error">{#each failed as o (o.id)}<p class="ds-fail" data-op={o.id}>{o.error} <span class="what">({describe(o)})</span> <button type="button" class="ds-retry-one" onclick={() => retry(o)}>Retry</button> <button type="button" class="ds-discard" onclick={() => discard(o)}>Discard</button></p>{/each}{#if failed.length > 1}<button type="button" id="ds-retry" onclick={retryAll}>Retry all</button>{:else}<button type="button" id="ds-retry" onclick={() => retry(failed[0]!)}>Retry</button>{/if}</div>{/if}
	{#if notice}<p class="notice" role="status" id="ds-notice">{notice}</p>{/if}
	{#if !data.present}
		<p class="empty">This results version has no discovery schedules.</p>
	{:else if ds.view === 'bundle'}
		<section aria-labelledby="ds-bundle-h" id="ds-bundle">
			<h2 id="ds-bundle-h">Court Bundle</h2>
			<p class="sub">{files.length} document{files.length === 1 ? '' : 's'} selected · assembled in schedule &amp; item order <button type="button" class="ds-btn" id="ds-back" disabled={off} onclick={() => { ds.view = 'schedule'; }}>◂ Back to schedule</button></p>
			<div class="ds-bar"><span class="cnt"><b id="ds-bundle-count">{files.length}</b> documents in this bundle</span><span class="sp"></span><button type="button" class="ds-btn pri" id="ds-print" disabled={off} onclick={printIndex}>Print / Save as PDF (index)</button><button type="button" class="ds-btn" id="ds-dlindex" disabled={off} onclick={indexDownload}>Download index (HTML)</button><button type="button" class="ds-btn" id="ds-empty" disabled={off} onclick={clearSel}>Empty bundle</button></div>
			{#if notes.length}<p class="warning" id="ds-incomplete"><b>Incomplete selection</b>: {notes.join('; ')}.</p>{/if}
			{#if !files.length}
				<div class="card"><div class="empty">No documents selected. Go back and tick documents, then Build court bundle.</div></div>
			{:else}
				<div class="grid-table"><table class="ds-tbl" id="ds-bundle-table"><thead><tr><th>#</th><th>Schedule</th><th>Item</th><th>Document</th><th>Date</th><th>C/O</th><th>Action</th></tr></thead><tbody>
					{#each files as f, idx (idx)}
						<tr data-key={f.key} class:unsaved={unsaved.has(f.key)}><td class="ds-no">{idx + 1}</td><td>{schedLabel(f.schedule)}</td><td class="ds-no">{f.no}.</td><td><div class="b">{f.desc}</div><div class="fn">{f.fn}</div></td><td class="ds-date">{f.date || ''}</td><td class={f.co === 'O' ? 'co-o' : 'co-c'}>{f.co}</td><td>{#if f.ref}<CitationLink resultsVersion={vid} ref={f.ref} label="Open" />{#if data.downloads[f.ref]}<a class="cite dl" href={data.downloads[f.ref]} rel="noopener noreferrer" download>Download</a>{/if}{:else}<span class="not-served">{NOT_SERVED}</span>{/if}<button type="button" class="rm" disabled={off} onclick={() => removeKey(f.key)}>Remove</button></td></tr>
					{/each}
				</tbody></table></div>
			{/if}
		</section>
		<section class="print-only" aria-hidden="true" id="ds-print-area">
			<h2>{data.caption.plaintiff ?? ''} v {data.caption.defendant ?? ''}</h2>
			<div class="cap">{data.caption.court ?? ''} {data.caption.division ?? ''} · {data.caption.caseNumber ?? ''}<br /><b>COURT BUNDLE — INDEX OF DOCUMENTS</b> ({files.length} documents)</div>
			{#if notes.length}<div class="cap"><b>INCOMPLETE SELECTION</b>: {notes.join('; ')}.</div>{/if}
			<table><thead><tr><th>#</th><th>Item</th><th>Description</th><th>Date</th><th>Document</th><th>C/O</th></tr></thead><tbody>
				{#each files as f, idx (idx)}
					{#if idx === 0 || files[idx - 1]!.schedule !== f.schedule}<tr class="sec"><td colspan="6">{schedLabel(f.schedule)}</td></tr>{/if}
					<tr><td>{idx + 1}</td><td>{f.no}.</td><td>{f.desc}</td><td>{f.date || ''}</td><td>{f.fn}{f.ref ? '' : ` [${NOT_SERVED.toUpperCase()}]`}</td><td>{f.co}</td></tr>
				{/each}
			</tbody></table>
		</section>
	{:else}
		<div class="ds-switch" role="group" aria-label="Schedule">
			{#each ['discovery', 'supplementary'] as const as m (m)}<button type="button" class:on={mode === m} aria-pressed={mode === m} data-mode={m} disabled={off} onclick={() => switchMode(m)}>{label(m)}</button>{/each}
		</div>
		<div class="ds-bar">
			<input class="ds-in" id="ds-q" disabled={off} placeholder="Filter item, description or file…" value={qInput} oninput={(e) => filter(e.currentTarget.value)} />
			<label class="ds-btn"><input type="checkbox" id="ds-missing" disabled={off} checked={ds.onlyMissing} onchange={(e) => { ds.onlyMissing = e.currentTarget.checked; }} />Only unmatched ({counts.unmatched})</label>
			<span class="sp"></span>
			<span class="cnt"><b id="ds-count">{sel.size}</b> selected</span>
			<button type="button" class="ds-btn" id="ds-mark-c" disabled={off} onclick={() => markSel('C')}>Mark Copy</button>
			<button type="button" class="ds-btn" id="ds-mark-o" disabled={off} onclick={() => markSel('O')}>Mark Original</button>
			<button type="button" class="ds-btn" id="ds-clear" disabled={off} onclick={clearSel}>Clear</button>
			<button type="button" class="ds-btn pri" id="ds-build" disabled={off} onclick={() => { ds.view = 'bundle'; }}>Build court bundle ▸</button>
		</div>
		<div class="ds-bar">
			<span class="cnt" id="ds-info">{#if meta.deed}<b>{meta.deed}</b>{' · '}{/if}{#if meta.schedule}{`${meta.schedule} · `}{/if}{counts.items} items · {counts.files} files linked{counts.declared !== counts.files ? ` (the schedule declares ${counts.declared})` : ''}{counts.notServed ? ` · ${counts.notServed} not in the verified index` : ''} · uncertified</span>
			<span class="sp"></span>
			<button type="button" class="ds-btn" id="ds-cover-open" disabled={off} onclick={coverOpen}>Open / print cover page</button>
			<button type="button" class="ds-btn" id="ds-cover-dl" disabled={off} onclick={coverDownload}>Download cover page (uncertified)</button>
		</div>
		<div id="ds-list">
			<div class="grid-table"><table class="ds-tbl"><thead><tr><th></th><th>Item</th><th>Document(s) &amp; description</th><th>Date</th></tr></thead><tbody>
				{#if !shown.length}<tr><td colspan="4" class="none">No items match.</td></tr>{/if}
				{#each shown as i, n (n)}
					{@const anySel = i.files.some((f) => sel.has(f.key))}
					{@const allSel = i.files.length > 0 && i.files.every((f) => sel.has(f.key))}
					<tr class:sel={anySel} data-item="{mode}-{i.no}"><td>{#if i.files.length}<input type="checkbox" checked={allSel} disabled={off} title="Select all files in this item" aria-label="Select all files in item {i.no}" onchange={(e) => toggleItem(i, e.currentTarget.checked)} />{/if}</td><td class="ds-no">{i.no}.{#if repeated.has(i.no)}<span class="dup" title="Another item of this schedule has the same number">repeated number</span>{/if}</td><td class="ds-desc"><div class="tx">{i.desc || '—'}</div>{#if i.files.length}<div class="ds-files">{#each i.files as f, j (j)}{@const c = fileCo(f, marks)}<div class="ds-chip" class:xref={!!f.x} class:unsaved={unsaved.has(f.key)} data-key={f.key}><input type="checkbox" checked={sel.has(f.key)} disabled={off} aria-label="Select {f.fn}" onchange={(e) => toggleFile(f.key, e.currentTarget.checked)} /><span class="fn" title={f.fn}>{f.fn}</span>{#if f.x}<span class="ds-x" title={f.x}>↪ {f.x}</span>{/if}<span class="ds-co"><button type="button" class:on-c={c === 'C'} aria-pressed={c === 'C'} aria-label="Copy" disabled={off} onclick={() => setCo(f.key, 'C')}>C</button><button type="button" class:on-o={c === 'O'} aria-pressed={c === 'O'} aria-label="Original" disabled={off} onclick={() => setCo(f.key, 'O')}>O</button></span>{#if f.ref}<CitationLink resultsVersion={vid} ref={f.ref} label="Open" />{#if data.downloads[f.ref]}<a class="cite dl" href={data.downloads[f.ref]} rel="noopener noreferrer" download>Download</a>{/if}{:else}<span class="not-served">{NOT_SERVED}</span>{/if}</div>{/each}</div>{:else if isUnmatched(i)}<div class="ds-none">{NO_DOCUMENT}</div>{/if}</td><td class="ds-date">{i.date || ''}</td></tr>
				{/each}
			</tbody></table></div>
		</div>
	{/if}
</main>

<style>
	.ds-switch { display: flex; gap: 6px; margin: 0 0 10px; }
	.ds-switch button.on { font-weight: 700; text-decoration: underline; }
	.ds-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
	.ds-bar .sp { flex: 1; }
	.ds-in { min-width: min(260px, 100%); }
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
	.fn { font-family: ui-monospace, monospace; font-size: 0.85em; overflow-wrap: anywhere; }
	.error { color: #b91c1c; }
	.ds-fail { margin: 2px 0; }
	.dup { margin-left: 4px; font-size: 0.8em; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 0 4px; }
	/* visible states kept out of the text content: saving, and a change that is not saved */
	main[aria-busy='true'] .ds-bar .cnt::after { content: ' · saving…'; color: #92400e; }
	.unsaved { outline: 2px dashed #b91c1c; }
	.ds-chip.unsaved::after { content: 'not saved'; color: #b91c1c; font-size: 0.8em; }
	.warning { color: #92400e; }
	.print-only { display: none; }
	@media print {
		main.ds-printing > :global(*:not(#ds-print-area)) { display: none !important; }
		main.ds-printing #ds-print-area { display: block; }
		:global(body:has(main.ds-printing) nav) { display: none !important; }
	}
</style>
