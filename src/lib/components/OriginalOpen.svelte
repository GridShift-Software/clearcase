<script lang="ts">
	// Open or download one original, with explicit missing, unsupported and parent-route states (BA-09). Labels come
	// from the verified mapping (its real path and the family the originals site serves), never from the row's
	// declared filename, media type or text claim alone. Links point at the separate originals site and open in a new
	// browsing context without opener or referrer; they carry the server's link capability.
	import { displayFilename } from '../case-package/browser.ts';
	import type { DocumentStateRow, OriginalLinks } from '../local-case/model.ts';
	// onDisk: why an original that was present at import cannot be served now (checked when the page renders), or null
	let { state, links, onDisk = null, page = null, parentHref = null }: { state: DocumentStateRow; links: OriginalLinks; onDisk?: string | null; page?: number | null; parentHref?: string | null } = $props();
	const o = $derived(state.original);
	const label = $derived(
		links.presentation === 'viewer' ? 'PDF, shown in the isolated ClearCase viewer (scripts in the file never run)'
		: links.presentation === 'inline' ? 'Image, shown on the isolated originals site'
		: links.presentation === 'text' ? 'Shown as plain text on the isolated originals site (never rendered as a page)'
		: 'Download only: this file is not displayed in the browser'
	);
</script>

<section class="original" aria-labelledby="original-heading" data-original-state={onDisk && state.file === 'present' ? 'missing' : state.file} data-on-disk={onDisk ? 'unavailable' : null} data-presentation={links.presentation ?? 'none'}>
	<h2 id="original-heading">Original</h2>
	{#if state.file === 'present' && o && onDisk}
		<p class="missing" id="original-state"><span class="route" data-route="unavailable">Original missing on disk</span>:
			<code class="wrap" title={o.path}>{displayFilename(o.path, 160)}</code> was verified when this results version was imported, but it is not available now ({onDisk}), so it is not served.
			Restore the file at that path in the case folder, or import a new results package.</p>
	{:else if state.file === 'present' && o}
		<p id="original-state">
			<span class="route" data-route="direct">Direct original</span>:
			<code class="wrap" title={o.path}>{displayFilename(o.path, 160)}</code>
			<small>({o.mediaType}, {o.size.toLocaleString('en')} bytes, sha256 {o.sha256.slice(0, 12)}…)</small>
		</p>
		<p id="original-family">{label}.
			{#if state.flags.includes('download-only')}<strong class="warning-inline" data-flag="download-only">Its content does not match its declared type, so it is offered only as a download.</strong>{/if}
			{#if state.flags.includes('case-mismatch')}<span data-flag="case-mismatch">Found under a differently cased or normalised name.</span>{/if}
		</p>
		<p class="actions">
			{#if links.presentation === 'viewer' && links.viewer}
				<a href="{links.viewer}{page ? `#page=${page}` : ''}" target="_blank" rel="noopener noreferrer" id="open-original">Open{page ? ` at page ${page}` : ''}</a>
			{:else if (links.presentation === 'inline' || links.presentation === 'text') && links.open}
				<a href={links.open} target="_blank" rel="noopener noreferrer" id="open-original">Open</a>
			{/if}
			{#if links.download}<a href={links.download} rel="noopener noreferrer" id="download-original" download>Download</a>{/if}
		</p>
	{:else if state.self && state.self.route === 'parent'}
		<p id="original-state"><span class="route" data-route="parent">Available through its parent</span>: this attachment is inside {#if parentHref}<a href={parentHref}>{state.self.parentRef}</a>{:else}{state.self.parentRef}{/if}; open the parent to reach it.</p>
	{:else if state.file === 'missing'}
		<p class="missing" id="original-state"><span class="route" data-route="unavailable">Original missing</span>: it was not found in the case folder when this results version was imported{state.self?.reason === 'parent-missing' ? ' (its parent container is missing too)' : ''}. It is not served.</p>
	{:else if state.flags.includes('embedded')}
		<p class="missing" id="original-state"><span class="route" data-route="unavailable">Unavailable</span>: this attachment is inside a parent container that has no verified original.</p>
	{:else}
		<p class="missing" id="original-state"><span class="route" data-route="unavailable">No original</span>: none is listed for this document.</p>
	{/if}
</section>
