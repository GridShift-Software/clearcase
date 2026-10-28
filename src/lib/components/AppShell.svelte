<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { setRouteBase, type ShellData } from './shell.ts';
	import TopBar from './TopBar.svelte';
	let { shell, sidebar, notice, children }: { shell: ShellData; sidebar: Snippet; notice?: Snippet; children: Snippet } = $props();
	setRouteBase(() => shell.base);

	// Under 40rem the sidebar is a drawer. Closed it is not rendered, so Tab skips it; the toggle in the top bar opens it.
	// Open it is modal: Tab cycles inside it, and the top bar, notices and main are inert behind the backdrop.
	let open = $state(false);
	let root = $state<HTMLElement>();
	const TOGGLE = 'nav-toggle';
	const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
	const inDrawer = () => [...(root?.querySelector('.side')?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
	const toggle = async () => {
		open = !open;
		if (!open) return;
		await tick();
		document.querySelector<HTMLElement>('.side a[aria-current="page"], .side a')?.focus();
	};
	// resolves once the inert attributes are off (the next flush), so a caller may move focus into the page straight away
	const close = async (refocus: boolean) => {
		if (!open) return;
		open = false;
		await tick();
		if (refocus) document.getElementById(TOGGLE)?.focus();
	};
	// a followed link closes the drawer, and the page's own heading takes focus after the navigation
	const side = (e: MouseEvent) => { if ((e.target as Element).closest('a')) close(false); };
	// Children render either main directly or a hosted analysis-content wrapper; cover the whole page in both cases.
	$effect(() => {
		if (!open || !root) return;
		const covered = [...root.querySelectorAll<HTMLElement>(':scope > .top-bar, :scope > .shell-notice, :scope > main, :scope > [data-testid="analysis-content"]')];
		for (const el of covered) el.inert = true;
		return () => { for (const el of covered) el.inert = false; };
	});
	// a drawer left open when the window widens past 40rem is just the sidebar again
	$effect(() => {
		if (!open) return;
		const wide = matchMedia('(min-width: 40.0625rem)');
		const on = () => { if (wide.matches) close(false); };
		wide.addEventListener('change', on);
		return () => wide.removeEventListener('change', on);
	});
	const keys = (e: KeyboardEvent) => {
		if (e.key === 'Escape') { close(true); return; }
		if (e.key !== 'Tab' || !open) return;
		const items = inDrawer();
		if (!items.length) return;
		const at = items.indexOf(document.activeElement as HTMLElement);
		const last = items.length - 1;
		if (at === -1 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) {
			e.preventDefault();
			items[at === -1 || !e.shiftKey ? 0 : last].focus();
		}
	};
</script>

<svelte:window onkeydown={keys} />

<div class="case-shell" class:nav-open={open} bind:this={root}>
	<div class="side" id="case-side" onclick={side} role="presentation">
		<p class="side-brand">{shell.brand}</p>
		{@render sidebar()}
	</div>
	<TopBar {shell} navOpen={open} navToggleId={TOGGLE} navControls="case-side" ontoggle={toggle} beforesearch={() => close(false)} />
	{#if notice}<div class="shell-notice">{@render notice()}</div>{/if}
	{#if open}<button type="button" class="drawer-backdrop" tabindex="-1" aria-hidden="true" onclick={() => close(true)}></button>{/if}
	<!-- each page renders its own main#main, set ready only once its content is usable -->
	{@render children()}
</div>
