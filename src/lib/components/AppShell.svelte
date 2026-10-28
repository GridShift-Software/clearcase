<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { setRouteBase, type ShellData } from './shell.ts';
	import TopBar from './TopBar.svelte';
	let { shell, sidebar, notice, children }: { shell: ShellData; sidebar: Snippet; notice?: Snippet; children: Snippet } = $props();
	setRouteBase(() => shell.base);

	// Under 40rem the sidebar is a drawer. Closed it is not rendered, so Tab skips it; the toggle in the top bar opens it.
	let open = $state(false);
	const TOGGLE = 'nav-toggle';
	const toggle = async () => {
		open = !open;
		if (!open) return;
		await tick();
		document.querySelector<HTMLElement>('.side a[aria-current="page"], .side a')?.focus();
	};
	const close = (refocus: boolean) => {
		if (!open) return;
		open = false;
		if (refocus) document.getElementById(TOGGLE)?.focus();
	};
	// a followed link closes the drawer, and the page's own heading takes focus after the navigation
	const side = (e: MouseEvent) => { if ((e.target as Element).closest('a')) close(false); };
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') close(true); }} />

<div class="case-shell" class:nav-open={open}>
	<div class="side" id="case-side" onclick={side} role="presentation">
		<p class="side-brand">{shell.brand}</p>
		{@render sidebar()}
	</div>
	<TopBar {shell} navOpen={open} navToggleId={TOGGLE} navControls="case-side" ontoggle={toggle} />
	{#if notice}<div class="shell-notice">{@render notice()}</div>{/if}
	{#if open}<button type="button" class="drawer-backdrop" tabindex="-1" aria-hidden="true" onclick={() => close(true)}></button>{/if}
	<!-- each page renders its own main#main, set ready only once its content is usable -->
	{@render children()}
</div>
