<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
	import { CONFIRM } from '$lib/components/confirm-delete';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { writeAccess } from '$lib/components/write-access';
	import { NOT_SERVED as LOCAL_NOT_SERVED, hrefOf, type Resolved } from '$lib/views/bundles/links';
	import { download } from '$lib/components/download';
	import { postAction } from '$lib/views/bundles/post';
	import { RELOAD_LOST, reloader } from '$lib/components/reload.svelte';
	import { printIndex } from '$lib/views/bundles/print';
	import { DOCX_TYPE, indexDocx } from '$lib/views/bundles/docx';
	import { HEADER_FIELDS, HEADER_KEYS, TO_COMPLETE, cleanName, desc, header, indexFileName, pad, partRange, range, totals, type Bundle, type Header } from '$lib/views/bundles/court';
	import Builder from '$lib/views/bundles/Builder.svelte';
	import { withStored, type StoredBundle } from '$lib/views/bundles/saved';
	import { blobs } from '$lib/views/bundles/builder.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	let { data } = $props();
	const access = writeAccess();
 const NOT_SERVED = $derived('hosted' in data && data.hosted ? 'not available on hosted' : LOCAL_NOT_SERVED);
	const vid = $derived(data.version.id);
	const c = $derived(data.content);
	// the custom bundles as the last save answered with them (GRS-264): the store's list replaces the loaded one, until a
	// load of the page brings its own. It belongs to the data it was answered over, so another case or version, or any
	// later load, shows that data as loaded.
	let answered = $state.raw<{ of: typeof data; list: StoredBundle[] } | null>(null);
	const lists = $derived(answered?.of === data ? withStored(data, answered.list, page.url.pathname) : data);
	const bs = $derived(lists.bundles);
	const ti = $derived(bs.reduce((n, b) => n + b.rows.length, 0));
	const tp = $derived(bs.reduce((n, b) => n + (b.pages || 0), 0));
	const extracts = $derived(c.kpiExtractsValue ?? bs.reduce((n, b) => n + b.rows.filter((r) => r.sliceUrl).length, 0));
	// the stored header: the save's answer sets it until the next load does (GRS-160)
	let stored = $derived(data.header);
	const hd = $derived(header(stored));

	const query = $derived((page.shallow?.url ?? page.url).searchParams);
	const view = $derived(query.get('view') === 'build' ? 'build' : query.has('b') ? 'bundle' : 'list');
	const repeated = $derived.by(() => { const seen = new Set<string>(), dup = new Set<string>(); for (const x of bs) (seen.has(x.no) ? dup : seen).add(x.no); return dup; });
	const bq = (i: number): Record<string, string> => (repeated.has(bs[i]!.no) ? { b: bs[i]!.no, at: String(i) } : { b: bs[i]!.no });
	const cur = $derived.by(() => {
		const no = query.get('b'), at = Number(query.get('at') ?? 'x');
		return Number.isInteger(at) && bs[at]?.no === no ? at : bs.findIndex((x) => x.no === no);
	});
	const b = $derived(cur >= 0 ? bs[cur]! : null);
	const tab = $derived(({ items: 'items', view: 'view' } as Record<string, string>)[query.get('tab') ?? ''] ?? 'index');
	const go = (q: Record<string, string>) => {
		void goto(`?${new URLSearchParams(q)}`, { shallow: true, reset: false });
		confirming = null;
	};
	const href = (r: Resolved | null, page?: number) => hrefOf(vid, lists.files, r, page);
	const blob = (x: Bundle) => (x.id ? (blobs[x.id] ?? null) : null);
	const rl = reloader();

	let delErrors = $state<Record<string, string>>({});
	let deleting = $state<Record<string, true>>({});
	const del = async (x: Bundle) => {
		const id = x.id;
		if (!id || deleting[id] || !confirm('Remove this bundle from the list? No document is deleted.')) return;
		deleting[id] = true;
		delete delErrors[id];
		try {
			const r = await postAction('delete', [['id', id]]);
			if (!r.ok) { delErrors[id] = r.message.replace(/^Not saved:/, 'Not removed:'); return; }
			const u = blobs[id];
			delete blobs[id];
			if (answered) answered = { of: answered.of, list: answered.list.filter((s) => s.id !== id) };
			if (u) URL.revokeObjectURL(u);
			await rl.reload();
		} finally { delete deleting[id]; }
	};

	type HAct = 'header' | 'restore' | 'clear';
	let hv = $state<Header>({ ...untrack(() => data.header) });
	let version = $state(untrack(() => data.headerHash));
	let errors = $state<Record<HAct, string | null>>({ header: null, restore: null, clear: null });
	let conflict = $state<Header | null>(null);
	let busy = $state<HAct | null>(null);
	let message = $state<string | null>(null);
	const changed = $derived(HEADER_KEYS.filter((k) => hv[k] !== stored[k]));
	// Restore and Clear replace the stored header: each runs once confirmed inline, and a Retry that would also discard
	// typed fields asks again (GRS-175)
	let confirming = $state<string | null>(null);
	afterNavigate((nav) => { if (nav.type !== 'enter') confirming = null; });
	const discards = $derived(changed.length ? ` Your ${changed.length} unsaved change${changed.length === 1 ? ' is' : 's are'} discarded too.` : '');
	const act = async (action: HAct, confirmed = false) => {
		if (action !== 'header' && changed.length && !confirmed) { confirming = action; return; }
		const sent = { ...hv };
		busy = action;
		try {
			const r = await postAction(action, [['version', version], ...(action === 'header' ? HEADER_KEYS.map((k): [string, string] => [k, sent[k]]) : [[CONFIRM, action] as [string, string]])]);
			if (!r.ok) {
				errors[action] = r.message;
				if (r.status === 409 && r.data?.stored) { conflict = r.data.stored as Header; version = String(r.data.version ?? version); }
				return;
			}
			// every stored answer of headerWrite (+page.server.ts) carries the header; without it no field can be told from the old data
			const answer = r.data?.stored as Header | undefined;
			if (!answer) throw new Error('The header action was saved without the stored header in its answer.');
			errors[action] = null;
			if (action !== 'header') errors.header = null;
			conflict = null;
			stored = answer;
			version = String(r.data?.version ?? version);
			for (const k of HEADER_KEYS) if (hv[k] === sent[k]) hv[k] = answer[k];
			if (!(await rl.reload())) return;
			version = data.headerHash;
			for (const k of HEADER_KEYS) if (hv[k] === answer[k]) hv[k] = data.header[k];
		} finally { busy = null; }
	};
	const saveHeader = () => act('header');
	const useStored = async () => {
		if (!(await rl.reload())) return;
		hv = { ...data.header };
		version = data.headerHash;
		conflict = null;
		errors = { header: null, restore: null, clear: null };
	};
	const headerFailed = $derived(Object.values(errors).some(Boolean));
	beforeNavigate((nav) => {
		if (nav.to?.route.id === nav.from?.route.id || (!changed.length && !headerFailed)) return;
		if (nav.type === 'leave' || !confirm('The index header has changes that are not saved. Leave this page and lose them?')) nav.cancel();
	});
	const rowsOf = (v: string) => Math.max(3, v.split(/\r?\n/).length + 1);

	const creator = () => c.docxCreator ?? 'ClearCase';
	const wordOne = (x: Bundle) => download(indexFileName(x), indexDocx([x], hd.h, creator()), DOCX_TYPE);
	const wordAll = () => { if (bs.length) download(c.allIndexesFileName ?? 'Court_Bundle_Indexes.docx', indexDocx(bs, hd.h, creator()), DOCX_TYPE); };
	const print = (x: Bundle) => { message = printIndex(x, hd.h) ? null : 'Allow pop-ups to print the index.'; };

	let ready = $state(false);
	const off = $derived(!ready);
	onMount(() => { ready = true; });
</script>

{#snippet notServed(what: string)}<span class="not-served">{what} ({NOT_SERVED})</span>{/snippet}

<main id="main" tabindex="-1" data-ready="court_bundle_tab" data-hydrated={ready ? '1' : null} data-busy={busy ? '1' : '0'}>
	<PageHeader heading="Court Bundle" section="Court Bundle" caseName={data.version.titleName} subtitle="{bs.length} bundles · {ti} index items · {tp} paginated pages. Every bundle is a finished PDF: index first, then the extracted documents, numbered continuously from page 1.">
		{#snippet actions()}<button type="button" class="btn sec" id="cb-word-all" disabled={off} onclick={wordAll}>All indexes (Word)</button> {#if access.canWrite}<button type="button" class="btn primary" data-testid="bundle-build" id="cb-build" disabled={off} onclick={() => go({ view: 'build' })}>Build a bundle</button>{/if}{/snippet}
	</PageHeader>
	{#if off}<p class="notice" id="cb-nojs">The header, the Word and print exports and the bundle tabs need JavaScript, which is off or still loading; nothing on this page can be saved without it.</p>{/if}
	{#if message}<p class="notice" role="status" id="cb-message">{message}</p>{/if}
	{#if rl.lost}<p class="error" role="alert" id="cb-reload-error">{RELOAD_LOST}</p>{/if}

	{#if view === 'build' && access.canWrite}
		<Builder bundles={bs} h={hd.h} creator={creator()} {off} onsaved={(list) => { if (list) answered = { of: data, list }; else void rl.reload(); }} onback={() => go({})} />
	{:else if view === 'bundle' && b}
		{@const t = totals(b)}
		{@const l = lists.links[cur]!}
		<section id="cb-bundle" aria-labelledby="cb-bundle-h">
			<h2 data-testid="bundle-heading" id="cb-bundle-h">{b.title}</h2>
			<p class="sub" id="cb-bundle-sub">{t.items} items · {t.pages} pages, numbered 1 to {t.pages}{t.missing ? ` · ${t.missing} item(s) flagged for review` : ''}</p>
			<div class="toolbar"><button type="button" class="btn sec" id="cb-all" disabled={off} onclick={() => go({})}>All bundles</button>
				{#if href(l.file)}<a class="btn sec" href={href(l.file)} target="_blank" rel="noopener">Open bundle PDF</a> {#if lists.downloads[l.file!.ref]}<a class="btn primary" href={lists.downloads[l.file!.ref]} rel="noopener noreferrer" download>Download bundle</a>{/if}{:else if blob(b)}<a class="btn sec" href={blob(b)} target="_blank" rel="noopener">Open bundle PDF</a>{:else if b.file}{@render notServed('Bundle PDF')}{/if}</div>
			<div class="toolbar" role="tablist" aria-label="Bundle">
				{#each [['index', 'Index'], ['items', 'Items & page numbers'], ['view', 'View bundle']] as [k, label] (k)}<button type="button" role="tab" aria-selected={tab === k} class="btn sm" class:primary={tab === k} id="cb-tab-{k}" disabled={off} onclick={() => go({ ...bq(cur), tab: k })}>{label}</button>{/each}
				{#if b.note}<span class="tag">{b.note}</span>{/if}
			</div>
			{#if tab === 'items'}
				<div class="card pad0"><div class="chead">Items — every page number below is the number printed on the page</div>
					<TableScroll label="Bundle items" class="wrap"><table class="tbl" id="cb-items"><thead><tr><th>Item</th><th>Ref</th><th>Description</th><th>Extracted from</th><th class="num">Pages</th><th class="num">Page nos.</th><th></th></tr></thead><tbody>
						{#if !b.rows.length}<tr><td colspan="7"><div class="empty">This bundle has no items yet.</div></td></tr>{/if}
						{#each b.rows as r, i (i)}
							{@const lr = l.rows[i]!}
							<tr><td class="mono"><b>{r.n}</b></td><td class="mono">{r.key || ''}</td>
								<td><div>{r.desc || '—'}</div>{#if r.blank}<div class="ex"><span class="badge b-info">intentionally blank</span></div>{/if}{#if r.missing && !r.blank}<div class="ex"><span class="badge b-warn">no file located — supply it or strike the item</span></div>{/if}{#if r.review && !r.missing && !r.blank}<div class="ex"><span class="badge b-info">extent auto-detected — verify</span></div>{/if}</td>
								<td>{#if !r.parts.length}<span class="tag">—</span>{/if}{#each r.parts as p, j (j)}<div>{#if href(lr.parts[j]!)}<a class="doc" href={href(lr.parts[j]!)}>{cleanName(p.name)} <span class="extlink">↗</span></a>{:else if p.url}{cleanName(p.name)} <span class="not-served">({NOT_SERVED})</span>{:else}{cleanName(p.name)}{/if} <span class="tag">{partRange(p)}</span></div>{/each}{#if r.caselines}<div class="ex">CaseLines {r.caselines.stamps} · {#if href(lr.caselines)}<a href={href(lr.caselines)} target="_blank" rel="noopener">verify page {r.caselines.from}</a>{:else}verify page {r.caselines.from} <span class="not-served">({NOT_SERVED})</span>{/if}</div>{/if}</td>
								<td class="num">{r.pages || 0}</td><td class="num mono"><b>{#if range(r)}{range(r)}{:else}<span class="tag">—</span>{/if}</b></td>
								<td>{#if r.sliceUrl}{#if href(lr.slice)}<a class="btn primary sm" href={href(lr.slice)} target="_blank" rel="noopener">Open item</a> {#if lists.downloads[lr.slice!.ref]}<a class="btn ghost sm" href={lists.downloads[lr.slice!.ref]} rel="noopener noreferrer" download>Save extract</a>{/if}{:else}{@render notServed('Extract')}{/if}{#if r.from}<div class="ex">{#if href(l.file)}<a href={href(l.file, r.from + b.indexPages)} target="_blank" rel="noopener">in the bundle at page {pad(r.from)}</a>{:else}in the bundle at page {pad(r.from)} <span class="not-served">({NOT_SERVED})</span>{/if}</div>{/if}
									{:else if blob(b) && r.from}<a class="btn primary sm" href="{blob(b)}#page={r.from + b.indexPages}" target="_blank" rel="noopener">Open item</a> <span class="tag">opens the bundle at page {pad(r.from)}</span>
									{:else if b.file && r.from}{#if href(l.file)}<a class="btn primary sm" href={href(l.file, r.from + b.indexPages)} target="_blank" rel="noopener">Open item</a> <span class="tag">opens the bundle at page {pad(r.from)}</span>{:else}{@render notServed('Open item')}{/if}
									{:else if r.parts.length && href(lr.parts[0]!)}<a class="btn primary sm" href={href(lr.parts[0]!)} target="_blank" rel="noopener">Open item</a>
									{:else}<span class="tag">—</span>{/if}</td></tr>
						{/each}
					</tbody></table></TableScroll></div>
				<div class="card"><h3>Reading this table</h3><div class="narr"><p>“Extracted from” is the source file and the pages taken out of it. “Page nos.” is where those pages sit in this bundle — the numbers stamped at the foot of each page and printed in the index.</p><p>“Open item” opens the extract on its own where one was cut (the pleadings), otherwise it opens the assembled bundle at that item’s first page. A file that is not in this version's verified document index is named but not served.</p></div></div>
			{:else if tab === 'view'}
				<div class="card">
					{#if href(l.file)}<div class="toolbar"><a class="btn primary" href={href(l.file)} target="_blank" rel="noopener">Open in a new tab</a>{#if lists.downloads[l.file!.ref]}<a class="btn sec" href={lists.downloads[l.file!.ref]} rel="noopener noreferrer" download>Download PDF</a>{/if}<button type="button" class="btn ghost" disabled={off} onclick={() => wordOne(b)}>Index (Word)</button><span class="tag">{b.pages || 0} pages</span></div>
						<div class="empty">Bundles are large files. Open it through its document page, which shows it in the isolated viewer.</div>
					{:else if b.file}<div class="toolbar"><button type="button" class="btn ghost" id="cb-view-word" disabled={off} onclick={() => wordOne(b)}>Index (Word)</button><span class="tag">{b.pages || 0} pages</span></div><div class="empty" id="cb-view-state">The assembled bundle PDF is {NOT_SERVED}, so it cannot be opened, downloaded or printed here.</div>
					{:else if blob(b)}<div class="toolbar" id="cb-view-session"><a class="btn primary" href={blob(b)} target="_blank" rel="noopener">Open in a new tab</a><a class="btn sec" href={blob(b)} download={`${b.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)}.pdf`}>Download PDF</a><button type="button" class="btn ghost" disabled={off} onclick={() => wordOne(b)}>Index (Word)</button><span class="tag">{b.pages || 0} pages</span></div>
						<div class="empty">Built in this session: the PDF stays available until this window is closed.</div>
					{:else}<div class="empty" id="cb-view-state">This bundle has not been assembled yet.{#if access.canWrite} Use the builder to create it.{/if}</div>{#if access.canWrite}<div class="toolbar"><button type="button" class="btn primary" id="cb-open-builder" disabled={off} onclick={() => go({ view: 'build' })}>Open the builder</button></div>{/if}{/if}
				</div>
			{:else}
				<div class="card" id="cb-index">
					<div class="toolbar"><button type="button" class="btn primary" id="cb-word" disabled={off} onclick={() => wordOne(b)}>Download Word (.docx)</button><button type="button" class="btn sec" id="cb-print" disabled={off} onclick={() => print(b)}>Print index</button>{#if href(l.indexFile)}<a class="btn sec" href={href(l.indexFile)} target="_blank" rel="noopener">Index PDF</a>{:else if b.indexFile}{@render notServed('Index PDF')}{/if}{#if href(l.file)}<a class="btn sec" href={href(l.file)} target="_blank" rel="noopener">Full bundle</a>{:else if blob(b)}<a class="btn sec" href={blob(b)} target="_blank" rel="noopener">Full bundle</a>{:else if b.file}{@render notServed('Full bundle')}{/if}{#if access.canWrite}<button type="button" class="btn ghost" id="cb-edit-header" disabled={off} onclick={() => go({})}>Edit header details</button>{/if}{#if hd.blank.length}<span class="badge b-warn">{hd.blank.length} header field(s) blank — placeholders shown</span>{/if}</div>
					<div class="cbindex" id="cbindexdoc">
						<p class="c">{hd.h.court}</p><p class="c">{hd.h.judge}</p><p class="cn">{hd.h.caseNo ? 'CASE NUMBER: ' + hd.h.caseNo : ''}</p><p>&nbsp;</p><p>{hd.h.intro}</p><p>&nbsp;</p>
						<p class="pt"><span>{hd.h.claimant}</span><span>{hd.h.claimantRole}</span></p><p>&nbsp;</p><p>and</p><p>&nbsp;</p>
						<p class="pt"><span>{hd.h.defendant}</span><span>{hd.h.defendantRole}</span></p><p>&nbsp;</p><p class="c bt">INDEX</p><p class="c bt2">{b.title}</p><p>&nbsp;</p>
						<table class="cbixt"><tbody>{#if !b.rows.length}<tr><td colspan="3">No items.</td></tr>{/if}{#each b.rows as r, i (i)}<tr class:to-complete={desc(r) === TO_COMPLETE}><td class="c">{r.n}.</td><td>{desc(r)}</td><td class="c">{range(r)}</td></tr>{/each}</tbody></table>
					</div>
				</div>
			{/if}
		</section>
	{:else if !data.present}
		<p class="empty">This results version has no court bundles.</p>
	{:else}
		<div class="grid g12">
			<div class="kpi"><div class="k">Bundles</div><div class="v">{bs.length}</div><div class="s">{c.kpiBundlesNote ?? 'imported bundle definitions'}</div></div>
			<div class="kpi"><div class="k">Index items</div><div class="v">{ti}</div><div class="s">listed across all bundles</div></div>
			<div class="kpi"><div class="k">Pages</div><div class="v">{tp}</div><div class="s">assembled and numbered</div></div>
			<div class="kpi"><div class="k">Extracts</div><div class="v">{extracts}</div><div class="s">{c.kpiExtractsNote ?? 'items with their own extract'}</div></div>
		</div>
		{#if access.canWrite}
		<div class="card" id="cb-header" aria-busy={busy !== null} data-changed={changed.length}>
			<h3>Index header details</h3>
			<div class="meta">These appear at the head of every index — the PDF index, the printed index and the Word index alike. The two party citations may run over several lines: type them exactly as they are to appear and each line prints on its own line, with the party label against the first line. Leave a field blank and the index prints a placeholder in square brackets for counsel to complete.{#if header(hv).blank.length}{' '}<b>{header(hv).blank.length} field{header(hv).blank.length === 1 ? '' : 's'} blank — placeholders will be used.</b>{/if}</div>
			<div class="row">
				{#each HEADER_FIELDS as f (f.key)}
					<div class="fld" class:ml={f.ml}><label class="tag" for="cbh_{f.key}">{f.label}</label>
						{#if f.ml}<textarea class="in" id="cbh_{f.key}" name={f.key} disabled={off} class:changed={changed.includes(f.key)} rows={rowsOf(hv[f.key])} placeholder={f.placeholder} bind:value={hv[f.key]}></textarea>
						{:else}<input class="in" id="cbh_{f.key}" name={f.key} disabled={off} class:changed={changed.includes(f.key)} placeholder={f.example ? (c.examples[f.key] ?? '') : f.placeholder} bind:value={hv[f.key]} />{/if}</div>
				{/each}
			</div>
			<div class="toolbar"><button type="button" class="btn primary" id="cb-save" disabled={off || busy !== null} onclick={saveHeader}>Save header</button><ConfirmDelete bind:pending={confirming} target="restore" question="Restore the matter defaults in every header field?{discards}" label="Restore matter defaults" confirmLabel="Confirm restore" onconfirm={() => act('restore', true)} id="cb-restore" aria-describedby={errors.restore ? 'cb-error-text-restore' : undefined} class="btn sec" disabled={off || busy !== null} /><ConfirmDelete bind:pending={confirming} target="clear" question="Clear every header field, so the index prints placeholders?{discards}" label="Clear all (use placeholders)" confirmLabel="Confirm clear" onconfirm={() => act('clear', true)} id="cb-clear" aria-describedby={errors.clear ? 'cb-error-text-clear' : undefined} class="btn ghost" disabled={off || busy !== null} />{#if busy}<span class="saving" id="cb-saving" role="status">Saving…</span>{:else if changed.length && !headerFailed}<span class="tag" id="cb-unsaved">{changed.length} field{changed.length === 1 ? '' : 's'} changed, not saved</span>{/if}</div>
			{#each ['header', 'restore', 'clear'] as const as k (k)}{#if errors[k]}<p class="error" role="alert" id={k === 'header' ? 'cb-error' : `cb-error-${k}`}><span id="cb-error-text-{k}">{errors[k]}</span> <button type="button" class="btn sm" id="cb-retry-{k}" disabled={off || busy !== null} onclick={() => act(k)}>Retry</button></p>{/if}{/each}
			{#if headerFailed || conflict}<div class="toolbar"><button type="button" class="btn sm" id="cb-discard" disabled={off || busy !== null} onclick={useStored}>{conflict ? 'Use the stored header' : 'Discard my header changes'}</button></div>{/if}
			{#if conflict}<div class="conflict" id="cb-conflict"><b>Stored now (saved in another tab):</b> {#each HEADER_FIELDS.filter((f) => conflict![f.key] !== hv[f.key]) as f (f.key)}<div><span class="tag">{f.label}:</span> <span class="v" data-field={f.key}>{conflict[f.key] || '(blank)'}</span></div>{/each}</div>{/if}
		</div>
		{/if}
		<div class="card pad0"><div class="chead">Bundles</div><div class="wrap"><TableScroll label="Bundles"><table class="tbl" id="cb-list"><thead><tr><th>No.</th><th>Bundle</th><th class="num">Items</th><th class="num">Pages</th><th>Status</th><th></th></tr></thead><tbody>
			{#each bs as x, i (i)}
				{@const t = totals(x)}
				{@const l = lists.links[i]!}
				<tr data-no={x.no}><td class="mono"><b>{x.no}</b>{#if repeated.has(x.no)}<span class="dup" title="Another bundle has the same number">repeated number</span>{/if}</td><td><div><b>{x.name}</b></div>{#if x.note}<div class="ex">{x.note}</div>{/if}</td><td class="num">{t.items}</td><td class="num">{t.pages}</td>
					<td>{#if x.id}<span class="badge b-info">custom</span>{' '}{/if}{#if t.missing}<span class="badge b-warn">{t.missing} to review</span>{:else}<span class="badge b-ok">complete</span>{/if}</td>
					<td><button type="button" class="btn primary sm" disabled={off} onclick={() => go({ ...bq(i), tab: 'index' })}>Open</button> {#if href(l.file)}<a class="btn sec sm" href={href(l.file)} target="_blank" rel="noopener">Bundle PDF</a>{:else if blob(x)}<a class="btn sec sm" href={blob(x)} target="_blank" rel="noopener">Bundle PDF</a>{:else if x.file}{@render notServed('Bundle PDF')}{:else if access.canWrite}<button type="button" class="btn sec sm" disabled={off} onclick={() => go({ view: 'build' })}>Create</button>{/if} {#if href(l.indexFile)}<a class="btn ghost sm" href={href(l.indexFile)} target="_blank" rel="noopener">Index PDF</a>{:else if x.indexFile}{@render notServed('Index PDF')}{/if}{x.indexFile ? ' ' : ''}<button type="button" class="btn ghost sm" disabled={off} onclick={() => wordOne(x)}>Word</button>{#if x.id && access.canWrite} <button type="button" class="btn ghost sm" data-delete={x.no} disabled={off || !!deleting[x.id]} onclick={() => del(x)}>Delete</button>{/if}
						{#if x.id && delErrors[x.id]}<p class="error" role="alert" data-delete-error={x.no}>{delErrors[x.id]}</p>{/if}</td></tr>
			{/each}
		</tbody></table></TableScroll></div></div>
		<div class="card"><h3>How the bundles are put together</h3><div class="narr">
			{#if c.extentNarrative}<p>{c.extentNarrative}</p>{/if}
			<p>The extracted pages are then stamped with the bundle’s own page numbers, starting at 1 on the first page of item 1 and running continuously to the last page of the last item. The index carries those same numbers, so the number in the index is the number printed on the page.</p>
			<p>The index pages themselves sit in front of page 1 and are not numbered, in the usual way.</p>
			{#if c.source || c.indexSource}<p class="tag">{c.source ? `Composition follows ${c.source}` : ''}{c.source && c.indexSource ? '; ' : ''}{c.indexSource ? `the index layout follows ${c.indexSource}` : ''}.</p>{/if}
		</div></div>
	{/if}
</main>

<style>
	.grid.g12 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
	@media (max-width: 40rem) { .grid.g12 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	#cb-bundle-h { overflow-wrap: anywhere; }
	.row { display: flex; flex-wrap: wrap; gap: 10px; }
	.fld { min-width: min(230px, 100%); flex: 1; display: flex; flex-direction: column; }
	.fld.ml { min-width: min(320px, 100%); flex: 2; }
	.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
	.ex, .tag { overflow-wrap: anywhere; }
	.not-served { color: #8a5a0b; font-style: italic; }
	.cbindex { font-family: Verdana, Geneva, sans-serif; font-size: 13px; line-height: 1.9; }
	.cbindex p { margin: 0; font-weight: 700; }
	.cbindex p.c { text-align: center; }
	.cbindex p.cn { text-align: right; font-size: 12px; }
	.cbindex p.pt { display: flex; justify-content: space-between; gap: 24px; }
	.cbindex p.pt span:first-child { white-space: pre-line; }
	.cbixt { border-collapse: collapse; width: 100%; }
	.cbixt td { border: 1px solid #000; padding: 6px 8px; font-weight: 700; vertical-align: top; }
	.cbixt td.c { text-align: center; white-space: nowrap; }
	.saving { color: #8a5a0b; font-weight: 600; }
	#cb-header[aria-busy='true'] .in { background: #fffbeb; }
	.in.changed { border-color: var(--warn); }
	.conflict { border: 1px solid var(--danger); border-radius: var(--radius); padding: 8px; margin: 6px 0; white-space: pre-line; }
</style>
