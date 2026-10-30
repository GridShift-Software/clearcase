<script lang="ts">
	let { data, form }: { data: { provider: string; href: string | null; options: unknown[] }; form: { message?: string } | null } = $props();
</script>

<h1>Operator sign-in</h1>
	<form method="POST" data-auth-provider={data.provider}>
		<button id="operator-sign-in" type="submit">Sign in as ClearCase staff</button>
		{#if form?.message}<p role="alert">{form.message}</p>{/if}
	</form>
	<p>Signing in here ends any session already open on this site. Access to a case still needs a grant.</p>
