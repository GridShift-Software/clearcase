<script lang="ts">
	// The degraded state of the document-row contract: a provider whose rows() failed is left out, and the reader says so.
	let { failed }: { failed: { source: string; owner: string; reason: string }[] } = $props();
</script>

{#if failed.length}
	<p class="banner recovery" id="degraded-documents" role="status" data-degraded={failed.map((f) => f.source).join(' ')}>
		Some documents are not shown: {#each failed as f, i (f.source)}{i ? '; ' : ''}the document-row provider <code>{f.source.replace(/^provider:/, '')}</code> ({f.owner}) failed ({f.reason}){/each}. The imported results are complete.
	</p>
{/if}
