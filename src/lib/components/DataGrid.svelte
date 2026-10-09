<script lang="ts" module>
	export type Column = { key: string; label: string; width: string; sortable?: boolean; align?: 'end' };
</script>

<script lang="ts" generics="T">
	// Table primitive for large lists: a div grid with ARIA table semantics (content-visibility does not apply to table
	// rows), sticky header, sortable column buttons with aria-sort, and rows keyed by a stable id, never by index.
	import type { Snippet } from 'svelte';
	let { columns, rows, rowKey, label, sort = null, onsort, cell, rowAttrs = () => ({}) }: {
		columns: readonly Column[]; rows: readonly T[]; rowKey: (r: T) => string; label: string;
		sort?: { key: string; dir: 1 | -1 } | null; onsort?: (key: string) => void; cell: Snippet<[T, Column]>;
		rowAttrs?: (r: T) => Record<string, string>;
	} = $props();
	const template = $derived(columns.map((c) => c.width).join(' '));
</script>

<div class="grid-table" role="table" aria-label={label} aria-rowcount={rows.length + 1} style:--cols={template}>
	<div class="grid-row grid-head" role="row">
		{#each columns as c (c.key)}
			<span role="columnheader" aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} class:end={c.align === 'end'}>
				{#if c.sortable && onsort}<button type="button" onclick={() => onsort(c.key)} id="sort-{c.key}">{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>{:else}{c.label}{/if}
			</span>
		{/each}
	</div>
	{#each rows as r (rowKey(r))}
		<div class="grid-row" role="row" {...rowAttrs(r)}>
			{#each columns as c (c.key)}<span role="cell" class:end={c.align === 'end'}>{@render cell(r, c)}</span>{/each}
		</div>
	{/each}
</div>
