<script lang="ts">
	import { page } from '$app/state';
	const title = $derived(page.status === 401 ? 'Sign in required' : page.status === 404 ? 'Not found' : page.status === 403 ? 'Not allowed' : page.status === 410 ? 'No longer available' : 'Unavailable');
</script>

<section class="denial" data-denial-code={page.error?.code ?? 'error'} data-status={page.status}>
	<h1>{title}</h1>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	{#if page.status === 401}<p><a id="sign-in-link" data-sveltekit-preload-data="off" href="/sign-in">Sign in</a></p>{/if}
</section>
