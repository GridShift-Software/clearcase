<script lang="ts">
	import { page } from '$app/state';
	import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<main id="main" tabindex="-1" data-ready="error:{page.status}">
	<PageHeader heading={page.status === 404 ? 'Not found' : `Error ${page.status}`} section={page.status === 404 ? 'Not found' : 'Error'} />
	<p class="error" role="alert">{page.error?.message ?? 'Something went wrong.'}</p>
	<p><a href="/">Go to the active case</a> · <a href="/import">Import results</a></p>
</main>
