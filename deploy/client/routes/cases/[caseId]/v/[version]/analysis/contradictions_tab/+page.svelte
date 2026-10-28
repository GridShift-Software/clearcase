<script lang="ts">
  import Page from '$local/analysis/contradictions_tab/+page.svelte';
  import type { ComponentProps } from 'svelte';
  let { data }: { data: ComponentProps<typeof Page>['data'] & { empty: boolean } } = $props();
</script>
<div data-testid="analysis-content" data-empty={String(data.empty)}><Page {data} /></div>
