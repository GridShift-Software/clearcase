<script>
	import Page from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.svelte';
	let { initial } = $props();
	let data = $state(initial);
	export function navigate(next) { data = next; }
</script>
<Page {data} />
