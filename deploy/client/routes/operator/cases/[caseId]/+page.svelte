<script lang="ts">
  import OperatorWorkbench from '$lib/views/hosted/OperatorWorkbench.svelte';
  import type { WorkbenchData } from '$lib/views/hosted/OperatorWorkbench.svelte';
  let { data }: { data: WorkbenchData } = $props();
</script>

{#key data.caseId}<OperatorWorkbench {data} />{/key}
