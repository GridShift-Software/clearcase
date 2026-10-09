<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	let { data, children } = $props();

	// BA-14: after a client-side navigation (link, Back, Forward), focus moves to the new page's heading, so keyboard
	// and screen-reader users start at the new content instead of the top of the document.
	afterNavigate(({ type }) => {
		if (type === 'enter') return;
		document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll: type === 'popstate' });
	});
	// Pages show mutable state (active version, user work). A page restored from the back/forward cache asks whether
	// anything changed since it was rendered and reloads only then, so unchanged form input is not thrown away.
	onMount(() => {
		const h = async (e: PageTransitionEvent) => {
			if (!e.persisted) return;
			const r = await fetch('/api/state', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
			if (!r || r.stamp !== data.stamp) location.reload();
		};
		addEventListener('pageshow', h);
		return () => removeEventListener('pageshow', h);
	});
</script>

<a class="skip" href="#main">Skip to content</a>
<header class="top"><span class="brand">ClearCase</span><a href="/" id="nav-active-case">Active case</a><a href="/import" id="nav-import">Import results</a></header>
{#each data.warnings as w (w.key)}
	<div class="banner recovery" id="warning-{w.key}" data-warning={w.key} role="alert">{w.message}</div>
{/each}
{#if data.recovery}
	<div class="banner recovery" id="recovery-banner" role="alert">
		RECOVERY: the active results version <code>{data.recovery.configured}</code> failed its integrity check at startup ({data.recovery.reason}).
		{#if data.recovery.effective}
			Showing <code>{data.recovery.effective}</code>, the newest version that was activated before and still verifies.
			<form method="POST" action="/recovery?/adopt"><input type="hidden" name="case" value={data.recovery.caseId} /><button id="recovery-adopt">Make it the active version</button></form>
		{:else}
			No earlier activation verifies; import the package again.
		{/if}
		<a href="/recovery">Details</a>
	</div>
{/if}
{@render children()}
