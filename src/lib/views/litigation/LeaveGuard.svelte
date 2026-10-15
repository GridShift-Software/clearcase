<script lang="ts">
	// Asks before an in-app navigation drops unsaved input (GRS-18 r2): an entry typed, refused or in flight, or a
	// status choice not saved. Reload and close get the browser's own prompt (SvelteKit's 'leave' navigation, cancelled).
	import { beforeNavigate, goto } from '$app/navigation';
	import { askFocus } from '$lib/components/ask-focus.svelte';
	let { unsaved, what }: { unsaved: boolean; what: string } = $props();
	let ask = $state<URL | null>(null);
	let leaving = false;
	let opener: Element | null = null;
	beforeNavigate((nav) => {
		if (leaving || nav.type === 'form' || !unsaved) return;
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		if (!ask) opener = document.activeElement;
		ask = nav.to.url;
	});
	askFocus(() => ask !== null, 'lit-ask', 'lit-ask-stay');
	function stay() {
		ask = null;
		const el = opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? opener : document.getElementById('main');
		opener = null;
		el?.focus();
	}
	function leave() {
		const url = ask;
		ask = null;
		if (!url) return;
		leaving = true;
		void goto(url).finally(() => { leaving = false; });
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
