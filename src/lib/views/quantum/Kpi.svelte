<script lang="ts">
	// A key figure as v5 lays it out (label, value, caption), shared by the quantum views. Text only.
	import type { Snippet } from 'svelte';
	let { label, value = '', sub = '', id = null, children }: { label: string; value?: string; sub?: string; id?: string | null; children?: Snippet } = $props();
</script>

<div class="kpi" id={id}>
	<div class="k">{label}</div>
	<div class="v">{#if children}{@render children()}{:else}{value}{/if}</div>
	{#if sub}<div class="s">{sub}</div>{/if}
</div>
