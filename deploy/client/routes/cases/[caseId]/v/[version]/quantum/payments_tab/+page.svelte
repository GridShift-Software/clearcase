<script lang="ts">
  import Page from '$local/quantum/payments_tab/+page.svelte';
  import type { ComponentProps } from 'svelte';
  let { data, form }: { data: ComponentProps<typeof Page>['data'] & { empty: boolean }; form: ComponentProps<typeof Page>['form'] } = $props();
</script>

<div class="analysis-content" data-testid="analysis-content" data-empty={data.empty}>
  <Page {data} {form} />
</div>
