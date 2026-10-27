<script lang="ts">
	let { data, form }: { data: { provider: string; href: string | null; options: unknown[]; pending?: { to: string; attempt: string }[] }; form: { message?: string } | null } = $props();
</script>

<h1>Operator sign-in</h1>
{#if data.pending}
	<p>You are signed in. More than one tab started signing in here; choose where this one goes.</p>
	<ul>{#each data.pending as p (p.attempt)}<li><form method="POST"><input type="hidden" name="attempt" value={p.attempt} /><button type="submit">{p.to}</button></form></li>{/each}</ul>
{:else}
	<form method="POST" data-auth-provider={data.provider}>
		<button id="operator-sign-in" type="submit">Sign in as ClearCase staff</button>
		{#if form?.message}<p role="alert">{form.message}</p>{/if}
	</form>
	<p>Signing in here ends any session already open on this site. Access to a case still needs a grant.</p>
{/if}
