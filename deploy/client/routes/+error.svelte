<script lang="ts">
	import { page } from '$app/state';
	import { signInHref } from '$lib/auth/sign-in-link';
	const title = $derived(page.status === 401 ? 'Sign in required' : page.status === 404 ? 'Not found' : page.status === 403 ? 'Not allowed' : page.status === 410 ? 'No longer available' : 'Unavailable');
</script>

<section class="denial" data-denial-code={page.error?.code ?? 'error'} data-status={page.status}>
	<h1>{title}</h1>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	{#if page.status !== 401}<p><a id="cases-link" href="/cases">Back to your cases</a></p>{/if}
	{#if page.status === 401}<p><a id="sign-in-link" href={signInHref(page.url.pathname + page.url.search)} data-sveltekit-reload data-sveltekit-preload-data="off">Sign in</a></p>{/if}
</section>
