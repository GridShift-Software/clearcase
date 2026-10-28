<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setRouteBase, type ShellData } from './shell.ts';
	import TopBar from './TopBar.svelte';
	let { shell, sidebar, notice, children }: { shell: ShellData; sidebar: Snippet; notice?: Snippet; children: Snippet } = $props();
	setRouteBase(() => shell.base);
</script>

<div class="case-head">
	<TopBar {shell} />
	{@render notice?.()}
</div>
<!-- each page renders its own main#main, set ready only once its content is usable -->
<div class="case-shell">
	{@render sidebar()}
	{@render children()}
</div>
