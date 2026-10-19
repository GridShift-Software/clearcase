<script lang="ts">
	let { data, form }: { data: { provider: string; options: { value: string; label: string }[] }; form: { message?: string } | null } = $props();
</script>

<h1>Sign in</h1>
<p data-auth-provider="double">Test identity double ({data.provider}): synthetic fixture identities only. A real identity provider replaces it.</p>
<form method="POST">
	<label for="test-identity">Identity</label>
	<select id="test-identity" name="identity" required>
		{#each data.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
	</select>
	<button id="sign-in" type="submit">Sign in</button>
	{#if form?.message}<p role="alert">{form.message}</p>{/if}
</form>
