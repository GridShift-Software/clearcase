<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import Page from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.svelte';
	type Data = ComponentProps<typeof Page>['data'];
	let { initial }: { initial: Data } = $props();
	let data = $state(untrack(() => initial));
	export function navigate(next: Data) { data = next; }
</script>
<Page {data} />
