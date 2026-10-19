<script lang="ts">
	let { data }: { data: { subject: string | null; cases: { caseId: string; label: string; href: string; published: boolean }[] } } = $props();
</script>

<div data-auth-state="signed-in">
	<p>Signed in as {data.subject}.</p>
	<form method="POST" action="/sign-out"><button id="sign-out" type="submit">Sign out</button></form>
</div>
<h1>Cases</h1>
{#if data.cases.length}
	<ul>
		{#each data.cases as c (c.caseId)}
			<li><a data-case-id={c.caseId} data-action="open-case" href={c.href}>{c.label}</a>{c.published ? '' : ' (results not published)'}</li>
		{/each}
	</ul>
{:else}
	<p data-empty="cases">No case is shared with you yet.</p>
{/if}
