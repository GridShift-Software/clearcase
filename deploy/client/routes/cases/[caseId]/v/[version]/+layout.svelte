<script lang="ts">
	import '$lib/../app.css';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import AppShell from '$lib/components/AppShell.svelte';
	import ViewNav from '$lib/components/ViewNav.svelte';
	import type { ShellData } from '$lib/components/shell';
	import type { HostedLayoutData } from '$lib/views/hosted/model';
	import { setHostedWriteAccess } from '$lib/components/write-access';
	let { data, children }: { data: HostedLayoutData; children: Snippet } = $props();
	setHostedWriteAccess(() => data.canWrite);
	const routeId = $derived(page.route.id ?? '');
	const current = $derived(routeId.endsWith('/[category]/[view]') ? page.params.view ?? null : routeId.endsWith('/[category]') ? page.params.category ?? null : routeId.split('/').at(-1) ?? null);
	const shell = $derived<ShellData>({ ...data.shell, current });
</script>

<AppShell {shell}>
	{#snippet sidebar()}<ViewNav resultsVersion={data.version.id} {current} brand={data.version.brand} hosted />{/snippet}
	{@render children()}
</AppShell>
