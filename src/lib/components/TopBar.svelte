<script lang="ts">
	import type { ShellData } from './shell.ts';
	let { shell }: { shell: ShellData } = $props();
	const published = $derived(shell.published);
</script>

<div class="top-bar" data-testid="top-bar">
	<p class="top-brand">{shell.brand}</p>
	<p class="case-name" id="case-name">{shell.caseName}</p>
	<form class="top-search" role="search" method="GET" action={shell.searchHref}>
		<input type="search" name="q" aria-label="Search documents" placeholder="Search documents" data-testid="search-input" />
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
