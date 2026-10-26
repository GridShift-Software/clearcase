<script lang="ts">
	let { data, form }: { data: { provider: string; href: string | null; options: { value: string; label: string }[] }; form: { message?: string } | null } = $props();
</script>

<h1>Sign in</h1>
{#if data.href !== null}
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
