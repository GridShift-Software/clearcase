<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		addFile, docxBundle, fromBundle, indexDocxName, indexPdfName, newRow, pdfName, plan, rowDel, rowMove, savedBundle, segAdd, segDel, segFile, setSeg,
		sourcesOf, spec, title, unlinked, emptyBuilder,
	} from '../../bundles/builder.ts';
	import { assemble, EncryptedPdfError, indexOnly, open } from '../../bundles/pdf/index.ts';
	import { bld, blobs, docs, newId } from './builder.svelte.ts';
	import { pad, type Bundle, type Header } from './court.ts';
	import { DOCX_TYPE, indexDocx } from './docx.ts';
	import { download } from '../../components/download.ts';
	import { postAction } from './post.ts';
	import TableScroll from '$lib/components/TableScroll.svelte';

	let { bundles, h, creator, off, onback }: { bundles: Bundle[]; h: Header; creator: string; off: boolean; onback: () => void } = $props();
	const pl = $derived(plan(bld.b));
	const need = $derived(unlinked(pl));
	const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const size = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

	async function addFiles(input: HTMLInputElement) {
		const list = Array.from(input.files ?? []).filter((f) => /\.pdf$/i.test(f.name));
		const picked = input.files?.length ?? 0;
		input.value = '';
		if (!picked) return;
		if (!list.length) return alert('Only PDF files can go into a bundle.');
		bld.msg = `Reading ${list.length} file(s)…`;
		for (let i = 0; i < list.length; i++) {
			const f = list[i]!;
			if (!bld.b.files.some((x) => x.name === f.name && x.size === f.size)) {
				try {
					const doc = await open(new Uint8Array(await f.arrayBuffer()));
					const rec = addFile(bld.b, f.name, f.size, doc.pages().length);
					if (rec) docs.set(rec.id, doc);
				} catch (e) {
					alert(`Could not read ${f.name}${e instanceof EncryptedPdfError ? ': the file is password-protected. Remove the protection and try again.' : ': ' + why(e)}`);
				}
			}
			bld.msg = `Read ${i + 1} of ${list.length}…`;
		}
		bld.msg = '';
	}
	function clear() {
		if (!confirm('Clear the builder? Files and page selections are discarded.')) return;
		if (bld.out && !bld.out.saved && !bld.saving) URL.revokeObjectURL(bld.out.url);
		bld.b = { ...emptyBuilder(), name: bld.b.name, seq: bld.b.seq };
		docs.clear();
		bld.out = null;
		bld.saveError = null;
	}
	function startFrom(sel: HTMLSelectElement) {
		const src = bundles[Number(sel.value)];
		sel.value = '';
		if (!src) return;
		fromBundle(bld.b, src);
		bld.out = null;
		bld.saveError = null;
	}
	function seg(i: number, j: number, k: 'from' | 'to', input: HTMLInputElement) {
		setSeg(bld.b, i, j, k, input.value);
		// a clamped value equal to the stored one would leave the typed text showing
		const s = bld.b.rows[i]?.segs[j];
		if (s) input.value = String(s[k]);
	}
	const named = () => (bld.b.name = title(bld.b.name));

	async function run() {
		if (bld.busy) return;
		const p = plan(bld.b);
		if (!p.pages) return alert('Nothing to assemble — add at least one page range.');
		const bad = unlinked(p);
		if (bad.length && !confirm(`${bad.length} item(s) have no source file and will be skipped. Carry on?`)) return;
		const t = named();
		const snap = $state.snapshot(p);
		bld.busy = true;
		bld.prog = 'Assembling…';
		try {
			const t0 = performance.now();
			const sources = sourcesOf(snap).map((s) => ({ doc: docs.get(s.fileId)!, from: s.from, to: s.to }));
			const res = await assemble(sources, { start: 1, index: spec(snap, t, h), onProgress: (d, n, pages) => void (bld.prog = `Assembling… ${d} of ${n} ranges, ${pages} pages`) });
			if (bld.out && !bld.out.saved && !bld.saving) URL.revokeObjectURL(bld.out.url);
			const url = URL.createObjectURL(new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
			bld.out = { id: newId(), title: t, file: pdfName(t), pages: res.pages, indexPages: res.indexPages, bodyPages: res.bodyPages, plan: snap, url, saved: null };
			bld.saveError = null;
			bld.prog = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
		} catch (e) {
			alert('The bundle could not be assembled: ' + (e instanceof EncryptedPdfError ? 'one of the PDFs is password-protected.' : why(e)));
			bld.prog = '';
		} finally {
			bld.busy = false;
		}
	}
	function indexPdf() {
		const t = named();
		try {
			download(indexPdfName(t), indexOnly(spec(pl, t, h), pdfName(t)).bytes, 'application/pdf');
		} catch (e) { alert('Could not build the index: ' + why(e)); }
	}
	function indexWord() {
		const t = named();
		download(indexDocxName(t), indexDocx([docxBundle(pl, t, bld.out)], h, creator), DOCX_TYPE);
	}
	function print() {
		if (!bld.out) return;
		const w = window.open(bld.out.url, '_blank');
		if (!w) return alert('Allow pop-ups so the bundle can open for printing.');
		setTimeout(() => { try { w.focus(); w.print(); } catch { /* closed */ } }, 1200);
	}
	async function save() {
		const o = bld.out;
		if (!o || bld.saving) return;
		const { no: _, ...entry } = savedBundle(o, '');
		bld.saving = true;
		bld.saveError = null;
		try {
			const r = await postAction('save', [['id', o.id], ['bundle', JSON.stringify(entry)]]);
			if (!r.ok) {
				if (bld.out?.id === o.id) bld.saveError = r.message;
				else URL.revokeObjectURL(o.url);
				return;
			}
			const no = String(r.data?.no ?? '');
			o.saved = no;
			blobs[o.id] = o.url;
			await invalidateAll();
			if (page.url.searchParams.get('view') === 'build' && bld.out?.id === o.id) await goto(`?${new URLSearchParams({ b: no, tab: 'index' })}`);
		} finally {
			bld.saving = false;
		}
	}
</script>

<section id="cb-builder" aria-labelledby="cb-builder-h">
	<div class="toolbar"><h2 id="cb-builder-h">Build a bundle</h2><button type="button" class="btn sec" id="cb-builder-back" disabled={off} onclick={onback}>All bundles</button></div>
	<p class="sub">Choose PDFs, choose the pages you want out of each, and the app assembles them into one numbered bundle with its own index — in the browser, with nothing uploaded anywhere.</p>
	{#if off}
		<p class="notice" id="cb-builder-nojs">The bundle builder needs JavaScript, which is off or still loading: it reads the PDFs and assembles the bundle in this browser.</p>
	{:else}
		<div class="card" id="cbb-sources"><h3>1 · Source documents</h3>
			<div class="toolbar"><label class="btn primary" for="cbbfile">Add PDFs…</label>
				<input type="file" id="cbbfile" class="vh" multiple accept="application/pdf,.pdf" disabled={bld.busy} onchange={(e) => addFiles(e.currentTarget)} />
				<select class="in" id="cbbfrom" aria-label="Start from a defined bundle" onchange={(e) => startFrom(e.currentTarget)}>
					<option value="">Start from a defined bundle…</option>
					{#each bundles as x, i (i)}<option value={String(i)}>{x.title}</option>{/each}
				</select>
				<button type="button" class="btn ghost" id="cbbclear" onclick={clear}>Clear</button>
				<span class="count" id="cbbmsg" role="status">{bld.msg}</span></div>
			{#if !bld.b.files.length}
				<div class="empty">No PDFs added yet. “Add PDFs…” opens your file picker — select as many as you like, including from the case folders next to this app.</div>
			{:else}
				<TableScroll label="PDFs added" class="wrap"><table class="tbl" id="cbbfiles"><thead><tr><th>File</th><th class="num">Pages</th><th class="num">Size</th></tr></thead><tbody>
					{#each bld.b.files as f (f.id)}<tr><td class="mono name">{f.name}</td><td class="num">{f.pages}</td><td class="num">{size(f.size)}</td></tr>{/each}
				</tbody></table></TableScroll>
			{/if}
			{#if need.length}<div class="tag need" id="cbbneed"><b>{need.length} item(s) still need their source file.</b> Add the PDF with the matching file name and it will attach itself automatically.</div>{/if}
		</div>

		<div class="card pad0" id="cbb-items"><div class="chead">2 · Items, in the order they will appear</div>
			<TableScroll label="Bundle items" class="wrap"><table class="tbl items"><thead><tr><th>#</th><th>Description for the index</th><th>Pages taken from the source</th><th class="num">Pages</th><th class="num">Page nos.</th><th></th></tr></thead><tbody>
				{#if !pl.rows.length}<tr><td colspan="6"><div class="empty">Add a PDF, or start from a defined bundle, and the items appear here.</div></td></tr>{/if}
				{#each pl.rows as pr (pr.i)}
					{@const i = pr.i}
					<tr data-item={i + 1}><td class="mono"><b>{i + 1}</b></td>
						<td><input class="in" aria-label="Description of item {i + 1}" placeholder="e.g. AMENDED POC & ATTACHMENTS" bind:value={pr.row.desc} /></td>
						<td>{#each pr.segs as sg, j (j)}
							<div class="seg">
								<select class="in file" aria-label="Source file of item {i + 1}, range {j + 1}" onchange={(e) => segFile(bld.b, i, j, e.currentTarget.value)}>
									{#if !sg.file}<option value="" selected>— {sg.seg.name || 'file not added'} —</option>{/if}
									{#each bld.b.files as f (f.id)}<option value={f.id} selected={sg.file?.id === f.id}>{f.name}</option>{/each}
								</select>
								<span class="tag">pages</span>
								<input class="in pg" inputmode="numeric" aria-label="First page of item {i + 1}, range {j + 1}" value={sg.seg.from} onchange={(e) => seg(i, j, 'from', e.currentTarget)} />
								<span class="tag">to</span>
								<input class="in pg" inputmode="numeric" aria-label="Last page of item {i + 1}, range {j + 1}" value={sg.seg.to} onchange={(e) => seg(i, j, 'to', e.currentTarget)} />
								{#if sg.file}<span class="tag">of {sg.file.pages}</span>{:else}<span class="badge b-warn">file not added</span>{/if}
								<button type="button" class="btn ghost sm" title="Remove this range" aria-label="Remove range {j + 1} of item {i + 1}" onclick={() => segDel(bld.b, i, j)}>✕</button>
							</div>
						{/each}<button type="button" class="btn ghost sm" onclick={() => segAdd(bld.b, i)}>+ another range</button></td>
						<td class="num">{pr.pages}</td>
						<td class="num mono"><b>{pr.pages ? (pr.from === pr.to ? pad(pr.from) : `${pad(pr.from)} – ${pad(pr.to)}`) : '—'}</b></td>
						<td class="nowrap"><button type="button" class="btn ghost sm" aria-label="Move item {i + 1} up" onclick={() => rowMove(bld.b, i, -1)}>↑</button> <button type="button" class="btn ghost sm" aria-label="Move item {i + 1} down" onclick={() => rowMove(bld.b, i, 1)}>↓</button> <button type="button" class="btn ghost sm" aria-label="Remove item {i + 1}" onclick={() => rowDel(bld.b, i)}>✕</button></td></tr>
				{/each}
			</tbody></table></TableScroll>
			<div class="toolbar pad"><button type="button" class="btn sec sm" id="cbbnewrow" onclick={() => { if (!newRow(bld.b)) alert('Add at least one PDF first.'); }}>+ Add an item</button><span class="tag" id="cbbtotal">Total: {pl.rows.length} items · {pl.pages} pages</span></div>
		</div>

		<div class="card" id="cbb-create"><h3>3 · Create the bundle</h3>
			<div class="fld"><label class="tag" for="cbbname">Bundle name</label><input class="in" id="cbbname" placeholder="e.g. EXPERT REPORTS" bind:value={bld.b.name} /></div>
			<div class="toolbar"><button type="button" class="btn primary" id="cbbrun" disabled={bld.busy || !pl.pages} onclick={run}>Create Bundle</button><button type="button" class="btn sec" id="cbbindex" disabled={!pl.rows.length} onclick={indexPdf}>Index only (PDF)</button><button type="button" class="btn ghost" id="cbbword" disabled={!pl.rows.length} onclick={indexWord}>Index (Word)</button><span class="count" id="cbbprog" role="status">{bld.prog}</span></div>
			<div class="tag">The header details set on the Court Bundles page are used for the index. Page numbering starts at 1 on the first page of item 1 and runs continuously; the index pages sit in front and are not numbered.</div>
			{#if bld.out}
				<div class="toolbar out" id="cbbout"><a class="btn primary" id="cbbdownload" href={bld.out.url} download={bld.out.file}>Download PDF</a><a class="btn sec" href={bld.out.url} target="_blank" rel="noopener">Open in a new tab</a><button type="button" class="btn sec" onclick={print}>Print</button><button type="button" class="btn ghost" id="cbbsave" disabled={bld.saving} onclick={save}>Save to the bundle list</button><span class="badge b-ok">{bld.out.pages} pages ({bld.out.indexPages} index + {bld.out.bodyPages} numbered)</span>{#if bld.saving}<span class="saving" role="status">Saving…</span>{:else if bld.out.saved}<span class="tag" id="cbbsaved">Saved to the bundle list as {bld.out.saved}</span>{/if}</div>
				{#if bld.saveError}<p class="error" role="alert" id="cbb-save-error">{bld.saveError} <button type="button" class="btn sm" disabled={bld.saving} onclick={save}>Retry</button></p>{/if}
				<!-- v5 shows the built PDF in the page (CSP frame-src blob: only). No sandbox: Chromium does not render a PDF in a sandboxed frame. -->
				<div class="preview"><iframe id="cbbpreview" src="{bld.out.url}#page=1" title="New bundle"></iframe></div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
	.toolbar.pad { padding: 0 12px; }
	.toolbar.out { border-top: 1px solid var(--border); padding: 12px 20px; }
	.preview { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.preview iframe { display: block; width: 100%; height: 70vh; border: 0; }
	.toolbar h2 { margin: 0; flex: 1; overflow-wrap: anywhere; }
	.nowrap { white-space: nowrap; }
	.name { overflow-wrap: anywhere; }
	.tag, .count { overflow-wrap: anywhere; }
	.need { margin-top: 10px; }
	.seg { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }
	.seg .file { max-width: min(230px, 100%); }
	.seg .pg { width: 4.5em; text-align: right; }
	.fld { display: flex; flex-direction: column; max-width: 40rem; }
	#cbbfrom { max-width: min(320px, 100%); }
	label.btn { cursor: pointer; }
	.vh { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
	label.btn:has(+ .vh:focus-visible) { outline: 3px solid var(--focus); outline-offset: 2px; }
	.saving { color: #8a5a0b; font-weight: 600; }
	.empty { padding: 8px 0; }
	@media (max-width: 40rem) {
		.items thead { display: none; }
		.items tr, .items td { display: block; }
		.items td.num { text-align: left; }
		.items tr { border-bottom: 1px solid var(--border); padding: 6px 0; }
		.items td { border: 0; }
	}
</style>
