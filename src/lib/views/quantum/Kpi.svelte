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

<style>
	.kpi { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: .6rem .8rem; }
	.k { font-size: .8em; text-transform: uppercase; letter-spacing: .03em; color: #555; }
	.v { font-size: 1.25em; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.s { font-size: .85em; color: #555; }
</style>
