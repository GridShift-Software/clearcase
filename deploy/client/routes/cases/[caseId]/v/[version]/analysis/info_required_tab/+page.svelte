<script lang="ts">
  import Page from '$local/analysis/info_required_tab/+page.svelte';
  import type { ComponentProps } from 'svelte';
  let { data }: { data: ComponentProps<typeof Page>['data'] & { empty: boolean } } = $props();
</script>

<div class="analysis-content" data-empty={data.empty}>
  <Page {data} form={null} />
</div>
