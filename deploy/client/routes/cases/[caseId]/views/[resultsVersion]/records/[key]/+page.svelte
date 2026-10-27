<script lang="ts">
  import { displayFilename } from '$lib/views/hosted/display';
  let { data }: { data: { caseHref: string; label: string; html: string } } = $props();
</script>
<main id="main" tabindex="-1" data-view="source-records">
  <p><a href={data.caseHref}>{displayFilename(data.label)}</a> › Source records</p>
  <p>Source records. The calculated view is not yet available.</p>
  {@html data.html}
</main>
