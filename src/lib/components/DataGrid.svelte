<script lang="ts" module>
	export type Column = { key: string; label: string; sortable?: boolean; align?: 'end' };
</script>

<script lang="ts" generics="T">
	import { untrack, type Snippet } from 'svelte';
	import { selectsRow } from './row-select.ts';
	import TableScroll from './TableScroll.svelte';
	let { columns, rows, rowKey, label, gridClass, sort = null, onsort, cell, rowAttrs = () => ({}), onselect, selected = null, previewLabel = (r: T) => `Preview ${rowKey(r)}`, firstRows = 150 }: {
		columns: readonly Column[]; rows: readonly T[]; rowKey: (r: T) => string; label: string; gridClass: string;
		sort?: { key: string; dir: 1 | -1 } | null; onsort?: (key: string) => void; cell: Snippet<[T, Column]>;
		rowAttrs?: (r: T) => Record<string, string>;
		/** Selecting a row: a click on it outside its own controls (`selectsRow`), or its leading Preview button (the keyboard path). */
		onselect?: (r: T) => void; selected?: string | null; previewLabel?: (r: T) => string;
		/** Rows rendered at once (and so in the server's HTML); the rest follow a frame at a time. */
		firstRows?: number;
	} = $props();
	const rowClick = (e: MouseEvent, r: T) => { if (onselect && selectsRow(e.target)) onselect(r); };
	const STEP = 400;
	let limit = $state(untrack(() => firstRows));
	$effect(() => {
		void rows;
		const FIRST = firstRows;
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
		{#if onselect}<span role="columnheader" class="preview-cell"><span class="visually-hidden">Preview</span></span>{/if}
		{#each columns as c (c.key)}
			<span role="columnheader" aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} class:end={c.align === 'end'}>
				{#if c.sortable && onsort}<button type="button" onclick={() => onsort(c.key)} id="sort-{c.key}">{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>{:else}{c.label}{/if}
			</span>
		{/each}
	</div>
	{#each shown as r (rowKey(r))}
		{@const key = rowKey(r)}
		<!-- the row click is a pointer shortcut; the Preview button in the row is its keyboard equivalent -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="grid-row" class:selected={onselect && selected === key} role="row" aria-current={onselect && selected === key ? 'true' : undefined} {...rowAttrs(r)} onclick={onselect ? (e) => rowClick(e, r) : undefined}>
			{#if onselect}<span role="cell" class="preview-cell"><button type="button" class="preview" aria-pressed={selected === key} aria-label={previewLabel(r)} onclick={() => onselect(r)}>Preview</button></span>{/if}
			{#each columns as c (c.key)}<span role="cell" class:end={c.align === 'end'}>{@render cell(r, c)}</span>{/each}
		</div>
	{/each}
</div></TableScroll>
