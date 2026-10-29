<script lang="ts">
	let { data }: { data: { multipleSignIns?: boolean; name: string | null; cases: { caseId: string; label: string; href: string; published: boolean }[] } } = $props();
</script>

<div class="cases-page" data-auth-state="signed-in">
	<div class="cases-head">
		<div>
			<h1>Your cases</h1>
			{#if data.name}<p class="cases-who">Signed in as <span data-testid="account-name">{data.name}</span></p>{/if}
		</div>
		<form method="POST" action="/sign-out"><button id="sign-out" class="btn" type="submit">Sign out</button></form>
	</div>
	{#if data.multipleSignIns}<p class="notice" role="status">You started sign-in in more than one tab, so we brought you here.</p>{/if}
	{#if data.cases.length}
		<ul class="case-list">
			{#each data.cases as c (c.caseId)}
				<li class="card"><a class="case-link" data-case-id={c.caseId} data-action="open-case" href={c.href}><span class="case-name">{c.label}</span>{#if c.published}<span class="case-open">Open</span>{:else}<span class="badge b-info">No results yet</span>{/if}</a></li>
			{/each}
		</ul>
	{:else}
		<p class="card" data-empty="cases">No case is shared with you yet.</p>
	{/if}
</div>
