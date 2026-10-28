<script lang="ts">
	import { isSearchShortcut } from './shell-keys.ts';
	import type { ShellData } from './shell.ts';
	let { shell, navOpen = false, navToggleId = 'nav-toggle', navControls, ontoggle }: { shell: ShellData; navOpen?: boolean; navToggleId?: string; navControls?: string; ontoggle?: () => void } = $props();
	const published = $derived(shell.published);
	let search = $state<HTMLInputElement>();
	// Ctrl+K (Cmd+K on a Mac) moves to the search box from anywhere on the page
	const shortcut = (e: KeyboardEvent) => {
		if (!isSearchShortcut(e)) return;
		e.preventDefault();
		search?.focus();
		search?.select();
	};
</script>

<svelte:window onkeydown={shortcut} />

<div class="top-bar" data-testid="top-bar">
	{#if ontoggle}
		<button type="button" class="nav-toggle" id={navToggleId} aria-label="Case navigation" aria-expanded={navOpen} aria-controls={navControls} onclick={ontoggle}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
		</button>
	{/if}
	<p class="top-brand visually-hidden">{shell.brand}</p>
	<p class="case-name" id="case-name" title={shell.caseName}>{shell.caseName}</p>
	<form class="top-search" role="search" method="GET" action={shell.searchHref}>
		<input bind:this={search} type="search" name="q" aria-label="Search documents" placeholder="Search documents" data-testid="search-input" />
		<button type="submit" data-testid="search-submit">Search</button>
	</form>
	<p class="version-pill" data-testid="version-pill" data-published={published ? 'true' : 'false'}>
		{#if published}{published.label} · {published.documents.toLocaleString('en-GB')} documents{#if published.at} · <time datetime={published.at}>{published.at.slice(0, 10)}</time>{/if}{:else}Not published{/if}
	</p>
	{#if shell.account}
		<div class="account">
			<span data-testid="account-name">{shell.account.name}</span>
			<form method="POST" action={shell.account.signOutHref}><button type="submit" data-testid="sign-out">Sign out</button></form>
		</div>
	{/if}
	{#if shell.actions.length}
		<nav class="top-actions" aria-label="Case actions">{#each shell.actions as a (a.href)}<a href={a.href}>{a.label}</a>{/each}</nav>
	{/if}
</div>
