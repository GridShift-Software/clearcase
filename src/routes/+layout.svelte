<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	let { data, children } = $props();

	// BA-14: after a client-side navigation (link, Back, Forward), focus moves to the new page's heading, so keyboard
	// and screen-reader users start at the new content instead of the top of the document. A full page load reached by
	// Back or Forward (pages are no-store, so leaving the document reloads it) counts as Back or Forward; a fresh first
	// visit or a reload keeps the browser's own focus.
	const heading = (preventScroll: boolean) => document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll });
	const BACK_RELOAD = 'clearcase:back-reload';
	afterNavigate(({ type, to }) => {
		if (type === 'enter') {
			// a reload that the bfcache check below started on Back counts as that Back
			let reloadedOnBack = false;
			try { reloadedOnBack = sessionStorage.getItem(BACK_RELOAD) === location.href; sessionStorage.removeItem(BACK_RELOAD); } catch { /* storage blocked */ }
			if (reloadedOnBack || (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'back_forward') heading(true);
			return;
		}
		heading(type === 'popstate');
		// An entry with a fragment (#main from a skip link followed before the app started) makes SvelteKit move focus to
		// the fragment target after this callback (reset_focus, in a task); the heading takes it back in the next task.
		if (type === 'popstate' && to?.url.hash) setTimeout(() => heading(true));
	});
	// Back (or Forward) between entries of the SAME page, e.g. from an in-page #code-<CODE> link on the validation report
	// to the page's own entry, is a "shallow" popstate in SvelteKit: no navigation, so afterNavigate does not run. On
	// reaching the page's base entry (no fragment) the heading takes focus, as after any other Back.
	let shown = '';
	afterNavigate(() => { shown = location.pathname + location.search; });
	onMount(() => {
		const h = () => { if (!location.hash && location.pathname + location.search === shown) heading(true); };
		addEventListener('popstate', h);
		return () => removeEventListener('popstate', h);
	});
	// The skip link moves focus to the content without a history entry (with JavaScript); href="#main" is the fallback.
	const skip = (a: HTMLAnchorElement) => {
		const h = (e: MouseEvent) => { e.preventDefault(); document.getElementById('main')?.focus(); };
		a.addEventListener('click', h);
		return () => a.removeEventListener('click', h);
	};
	// Pages show mutable state (active version, user work). A page restored from the back/forward cache asks whether
	// anything changed since it was rendered and reloads only then, so unchanged form input is not thrown away.
	onMount(() => {
		const h = async (e: PageTransitionEvent) => {
			if (!e.persisted) return;
			const r = await fetch('/api/state', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
			if (r && r.stamp === data.stamp) return heading(true);
			try { sessionStorage.setItem(BACK_RELOAD, location.href); } catch { /* storage blocked: the reload keeps the browser's focus */ }
			location.reload();
		};
		addEventListener('pageshow', h);
		return () => removeEventListener('pageshow', h);
	});
</script>

<a class="skip" href="#main" {@attach skip}>Skip to content</a>
<header class="top"><span class="brand">ClearCase</span><a href="/cases" id="nav-cases">Cases</a><a href="/import" id="nav-import">Import results</a></header>
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
