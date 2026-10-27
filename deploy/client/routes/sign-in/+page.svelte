<script lang="ts">
	let { data, form }: { data: { provider: string; href: string | null; options: { value: string; label: string }[]; pending?: { to: string; href: string }[] }; form: { message?: string } | null } = $props();
</script>

<h1>Sign in</h1>
{#if data.pending}
	<p>You are signed in. More than one tab started signing in here; choose where this one goes.</p>
	<ul>{#each data.pending as p (p.to)}<li><a href={p.href}>{p.to}</a></li>{/each}</ul>
{:else if data.href !== null}
	<form method="POST" data-auth-provider="clerk">
		<button id="sign-in-link" type="submit">Sign in to ClearCase</button>
		{#if form?.message}<p role="alert">{form.message}</p>{/if}
	</form>
	<p>Accounts are by invitation only.</p>
{:else}
	<p data-auth-provider="double">Test identity double ({data.provider}): synthetic fixture identities only. A real identity provider replaces it.</p>
	<form method="POST">
		<label for="test-identity">Identity</label>
		<select id="test-identity" name="identity" required>
			{#each data.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
		</select>
		<button id="sign-in" type="submit">Sign in</button>
		{#if form?.message}<p role="alert">{form.message}</p>{/if}
	</form>
{/if}
