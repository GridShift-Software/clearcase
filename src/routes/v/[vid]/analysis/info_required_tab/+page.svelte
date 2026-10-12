<script lang="ts">
	import InfoChecklist from './InfoChecklist.svelte';
	let { data, form } = $props();
</script>

<!-- one checklist per results version: browsing from one case to another builds a new one, so no pending choice,
     in-flight save or error of the case left can reach the case entered (the page component is otherwise reused) -->
{#key data.version.id}
	<InfoChecklist {data} {form} />
{/key}
