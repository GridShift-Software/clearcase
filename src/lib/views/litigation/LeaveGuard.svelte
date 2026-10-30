<script lang="ts">
	// Asks before an in-app navigation drops unsaved input (GRS-18 r2): an entry typed, refused or in flight, or a
	// status choice not saved. Reload and close get the browser's own prompt (SvelteKit's 'leave' navigation, cancelled).
	// A navigation that stays on this page (its own reload after an action) keeps the input, so it is not asked about.
	// Leave runs `discard` first, for a page whose input would otherwise outlive the navigation (the next document opens
	// in the same page instance). Back or Forward goes on as the same traversal, so the entries beyond it stay (GRS-284).
	import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
	import { askFocus } from '$lib/components/ask-focus.svelte';
	let { unsaved, what, discard }: { unsaved: boolean; what: string; discard?: () => void } = $props();
	let ask = $state<{ url: URL; delta: number | null } | null>(null);
	let leaving = false;
	let opener: Element | null = null;
	beforeNavigate((nav) => {
		if (leaving || nav.type === 'form' || !unsaved) return;
		if (!nav.willUnload && nav.to?.url.pathname === nav.from?.url.pathname) return;
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		if (!ask) opener = document.activeElement;
		ask = { url: nav.to.url, delta: nav.type === 'popstate' ? nav.delta : null };
	});
	afterNavigate(() => { leaving = false; });
	askFocus(() => ask !== null, 'lit-ask', 'lit-ask-stay');
	function stay() {
		ask = null;
		const el = opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? opener : document.getElementById('main');
		opener = null;
		el?.focus();
	}
	function leave() {
		const to = ask;
		ask = null;
		if (!to) return;
		discard?.();
		leaving = true;
		if (to.delta) history.go(to.delta);
		else void goto(to.url).finally(() => { leaving = false; });
	}
</script>

{#if ask}
	<div class="ask" role="alertdialog" aria-modal="true" aria-labelledby="lit-ask-q" id="lit-ask">
		<p id="lit-ask-q">{what} Leave this page and lose it?</p>
		<button type="button" id="lit-ask-stay" onclick={stay}>Stay on this page</button>
		<button type="button" id="lit-ask-leave" onclick={leave}>Leave and discard it</button>
	</div>
{/if}

<style>
	.ask { position: fixed; inset: auto 1rem 1rem auto; max-width: 28rem; z-index: 50; }
	.ask p { margin: 0 0 0.5rem; }
	.ask button + button { margin-left: 0.5rem; }
</style>
