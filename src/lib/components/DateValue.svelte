<script lang="ts">
	import { dateBasis } from './format.ts';
	let { date, dateType = null, dateSource = null, compact = false }: { date: string; dateType?: string | null; dateSource?: string | null; compact?: boolean } = $props();
	const basis = $derived(dateBasis({ date, dateType, dateSource }));
</script>

{#if compact}<span class="date" title={basis} data-date-basis={dateType ? 'supplied' : 'unknown'}>{date || 'undated'}</span>{:else}<span class="date" data-date-basis={dateType ? 'supplied' : 'unknown'}>{date || 'undated'} <small class="basis">({basis})</small></span>{/if}
