<script lang="ts">
  import Page from '$local/registers/annotations_tab/+page.svelte';
  import type { ComponentProps } from 'svelte';
  let { data, form }: ComponentProps<typeof Page> = $props();
</script>

<Page {data} {form} />
