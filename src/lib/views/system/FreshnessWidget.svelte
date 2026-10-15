<script lang="ts">
	import type { WidgetContext } from '$lib/components/overview-slots';
	import { stamp, type FreshnessData } from './freshness';
	let { data }: { data: FreshnessData; ctx: WidgetContext } = $props();
</script>

<p id="freshness-stamp" data-documents={data.documents} data-via-rescan={data.viaRescan}>{stamp(data)}.</p>
<p id="freshness-scan"><small>
	{#if data.lastScan}Last rescan <time datetime={data.lastScan.at}>{data.lastScan.at.slice(0, 16).replace('T', ' ')}</time> ({data.lastScan.mode === 'full' ? 'full scan' : 'quick scan'}): {data.lastScan.verdict}
	{:else}The case folder has not been rescanned for this version.{/if}
	<a href={data.href}>Rescan &amp; Update</a>
</small></p>
