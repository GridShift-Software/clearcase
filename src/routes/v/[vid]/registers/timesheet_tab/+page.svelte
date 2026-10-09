<script lang="ts">
	import RegisterPage from '$lib/views/registers/RegisterPage.svelte';
	let { data, form } = $props();
</script>

<RegisterPage {data} {form} />
