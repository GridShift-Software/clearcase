<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CitationLink from '$lib/components/CitationLink.svelte';
	import DateValue from '$lib/components/DateValue.svelte';
	import OriginalOpen from '$lib/components/OriginalOpen.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { money } from '$lib/components/format';
	import { displayFilename } from '$lib/case-package/browser';
	import { docPath } from '$lib/local-case/model';
	let { data, form } = $props();
	const f = $derived(data.fields);
	const vid = $derived(data.version.id);
	const title = $derived(f.subject || f.filename);
	const rows = $derived([
		['Type', f.docType], ['Bundle', f.bundle], ['From', f.sender], ['To', f.to], ['Cc', f.cc], ['Amount', money(f.amount) ? `${money(f.amount)} (source value ${f.amount})` : ''],
		['Invoice number', f.invoiceNo], ['Size (source claim)', f.size === null ? '' : `${f.size.toLocaleString('en')} bytes`], ['Text status', f.textStatus], ['Also in', f.alsoIn.join('; ')],
	] as [string, string][]);
	let ready = $state(false);
	onMount(() => { ready = true; });
	// the note field takes no input while its save is in flight, so nothing typed then is lost when the form resets;
	// a save the app did not answer keeps the text with a message instead of replacing the page
	let noteBusy = $state(false);
	// a refused note's text lives only in this page; a Delete would reload it without that text, so it waits
	const noteRefused = $derived(!!form && 'body' in form);
	let noteError = $state<string | null>(null);
	const submitNote: SubmitFunction = () => {
		noteBusy = true;
		noteError = null;
		return async ({ result, update }) => {
			noteBusy = false;
			if (result.type === 'error') { noteError = 'The note was not saved: the app did not answer. Your text is kept; try again.'; return; }
			await update({ reset: result.type === 'success' });
		};
	};
</script>

<main id="main" tabindex="-1" data-ready={ready ? `doc:${data.ref}` : null}>
	<PageHeader heading="{data.ref} {title}" section="Document" caseName={data.version.titleName} document="{data.ref} {title}" />
	<table class="fields"><tbody>
		<tr><th scope="row">Date</th><td id="doc-date"><DateValue date={f.date} dateType={f.dateType} dateSource={f.dateSource} /></td></tr>
		<tr><th scope="row">Filename (source)</th><td class="wrap">{displayFilename(f.filename, 200)}</td></tr>
		{#each rows as [k, val] (k)}{#if val}<tr><th scope="row">{k}</th><td class="wrap">{val}</td></tr>{/if}{/each}
		{#if data.parent}<tr><th scope="row">Attachment of</th><td><CitationLink resultsVersion={vid} ref={data.parent.ref} exists={data.parent.exists} /></td></tr>{/if}
	</tbody></table>

	{#if data.source !== 'results'}<p id="doc-source" data-source={data.source}>This document comes from the document-row provider <code>{data.source.replace(/^provider:/, '')}</code>, not from the imported results.</p>{/if}
	<OriginalOpen state={data.state} links={data.links} onDisk={data.onDisk} page={data.page} parentHref={data.parent?.exists ? docPath(vid, data.parent.ref) : null} />

	{#if data.attachments.length || f.attachmentNames.length}
		<section aria-labelledby="att-heading" id="attachments"><h2 id="att-heading">Attachments</h2>
			{#if data.attachments.length}
				<ul>{#each data.attachments as x (x.key)}
					<li data-attachment={x.key} data-route={x.route}>
						<code>{x.key}</code> {x.member ? displayFilename(x.member) : ''} <small>({x.mediaType})</small>:
						{#if x.route === 'direct'}{#if x.hasDocument}<a href={docPath(vid, x.key)}>its own original</a>{:else if x.links?.download}<a href={x.links.download} rel="noopener noreferrer" download>download its own original</a>{:else}its own original{/if}
						{:else if x.route === 'parent'}inside this {x.via === data.ref ? 'message' : `container ${x.via}`}; {#if data.links.open || data.links.download}open <a href={data.links.open ?? data.links.download} rel="noopener noreferrer" target="_blank">the parent original</a> to reach it{:else}<span class="unresolved" data-parent="unavailable">the parent original is unavailable{data.onDisk ? ` (${data.onDisk})` : ''}, so this attachment cannot be reached now</span>{/if}
						{:else}<span class="unresolved">unavailable ({x.reason})</span>{/if}
					</li>
				{/each}</ul>
			{:else}
				<p>The source lists {f.attachmentNames.length} attachment name(s) without a parent link: {f.attachmentNames.map((n) => displayFilename(n, 80)).join('; ')}.</p>
			{/if}
		</section>
	{/if}
	{#if data.children.length}
		<section aria-labelledby="child-heading"><h2 id="child-heading">Extracted attachments</h2><ul>{#each data.children as c (c)}<li><CitationLink resultsVersion={vid} ref={c} /></li>{/each}</ul></section>
	{/if}
	{#if data.related.length}
		<section aria-labelledby="rel-heading"><h2 id="rel-heading">Related documents</h2><ul id="related">{#each data.related as r (r.ref)}<li><CitationLink resultsVersion={vid} ref={r.ref} exists={r.exists} /></li>{/each}</ul></section>
	{/if}
	{#if f.excerpt}
		<section aria-labelledby="ex-heading"><h2 id="ex-heading">Excerpt</h2><p><small>A short excerpt from the source register, not the document's full text.</small></p><p class="wrap" id="excerpt">{f.excerpt}</p></section>
	{/if}

	<section aria-labelledby="notes-heading"><h2 id="notes-heading">My notes</h2>
		<ul id="notes">
			{#each data.notes as n (n.id)}
				<li data-note={n.id} data-anchor={n.status}><span class="wrap">{n.body}</span> <small>({n.createdAt}{n.status === 'exact' ? `, written on ${n.refAtCreation} in an earlier version and re-attached by its original's fingerprint` : ''})</small>
					{#if n.status === 'ambiguous'}<strong class="warning-inline">This note was written on {n.refAtCreation} in another version; its original's bytes are shared by {n.candidates.join(', ')} here, so it is shown on each.</strong>{/if}
					{#if !n.intact}<strong class="unresolved" data-note-integrity="mismatch">this note was altered on disk since it was saved</strong>{/if}
					{#if n.status === 'here'}<form method="POST" action="?/delnote" use:enhance><input type="hidden" name="id" value={n.id} /><button aria-label="Delete note" disabled={noteRefused}>Delete</button></form>{/if}
				</li>
			{:else}<li>No notes.</li>{/each}
		</ul>
		{#if data.source === 'results'}
			<form method="POST" action="?/note" use:enhance={submitNote} id="note-form">
				<label for="note-body">Add a note</label><br /><textarea name="body" rows="3" cols="80" id="note-body" readonly={noteBusy} value={form && 'body' in form ? String(form.body) : ''}></textarea><br /><button id="note-add" disabled={noteBusy}>Add note</button>
				{#if noteError ?? form?.message}<span class="error" role="alert">{noteError ?? form?.message}</span>{/if}
				{#if noteRefused}<p class="note" id="note-delete-off">Delete is off until this note is saved: add it again, or reload the page to discard it.</p>{/if}
			</form>
		{:else}
			<p id="note-unavailable">Notes are not available on this document: it has no imported original to anchor a note to, so a note would be lost when a new results version is imported.</p>
		{/if}
	</section>
</main>
