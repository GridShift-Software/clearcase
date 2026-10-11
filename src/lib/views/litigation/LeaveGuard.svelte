<script lang="ts">
	// Asks before an in-app navigation drops unsaved input (GRS-18 r2): an entry typed, refused or in flight, or a
	// status choice not saved. Reload and close get the browser's own prompt (SvelteKit's 'leave' navigation, cancelled).
	import { beforeNavigate, goto } from '$app/navigation';
	let { unsaved, what }: { unsaved: boolean; what: string } = $props();
	let ask = $state<URL | null>(null);
	let leaving = false;
	beforeNavigate((nav) => {
		if (leaving || nav.type === 'form' || !unsaved) return;
		nav.cancel();
		if (nav.type === 'leave' || !nav.to) return;
		ask = nav.to.url;
	});
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
		<!-- svelte-ignore a11y_autofocus -->
		<button type="button" id="lit-ask-stay" autofocus onclick={() => (ask = null)}>Stay on this page</button>
		<button type="button" id="lit-ask-leave" onclick={leave}>Leave and discard it</button>
	</div>
{/if}

<style>
	.ask { position: fixed; inset: auto 1rem 1rem auto; max-width: 28rem; background: #fff; border: 2px solid #b3261e; padding: 0.75rem; z-index: 50; box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); }
	.ask p { margin: 0 0 0.5rem; }
	.ask button + button { margin-left: 0.5rem; }
</style>
