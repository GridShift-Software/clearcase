<script lang="ts" module>
	export type Column = { key: string; label: string; sortable?: boolean; align?: 'end' };
</script>

<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import TableScroll from './TableScroll.svelte';
	let { columns, rows, rowKey, label, gridClass, sort = null, onsort, cell, rowAttrs = () => ({}) }: {
		columns: readonly Column[]; rows: readonly T[]; rowKey: (r: T) => string; label: string; gridClass: string;
		sort?: { key: string; dir: 1 | -1 } | null; onsort?: (key: string) => void; cell: Snippet<[T, Column]>;
		rowAttrs?: (r: T) => Record<string, string>;
	} = $props();
	const FIRST = 150, STEP = 400;
	let limit = $state(FIRST);
	$effect(() => {
		void rows;
		limit = FIRST;
		let id = 0;
		const grow = () => { limit = Math.min(rows.length, limit + STEP); if (limit < rows.length) id = requestAnimationFrame(grow); };
		if (rows.length > FIRST) id = requestAnimationFrame(grow);
		return () => cancelAnimationFrame(id);
	});
	const shown = $derived(rows.length <= limit ? rows : rows.slice(0, limit));
</script>

<TableScroll {label}><div class="grid-table {gridClass}" role="table" aria-rowcount={rows.length + 1} data-complete={shown.length === rows.length}>
	<div class="grid-row grid-head" role="row">
		{#each columns as c (c.key)}
			<span role="columnheader" aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} class:end={c.align === 'end'}>
				{#if c.sortable && onsort}<button type="button" onclick={() => onsort(c.key)} id="sort-{c.key}">{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>{:else}{c.label}{/if}
			</span>
		{/each}
	</div>
	{#each shown as r (rowKey(r))}
		<div class="grid-row" role="row" {...rowAttrs(r)}>
			{#each columns as c (c.key)}<span role="cell" class:end={c.align === 'end'}>{@render cell(r, c)}</span>{/each}
		</div>
	{/each}
</div></TableScroll>
