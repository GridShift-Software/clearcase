<script lang="ts">
	import CitationLink from '$lib/components/CitationLink.svelte';
	import TableScroll from '$lib/components/TableScroll.svelte';
	import { relationshipLayout, type Anchor, type RelationshipGraph } from './supplemental';
	let { anchors, graph, resultsVersion, known }: { anchors: Anchor[] | null; graph: RelationshipGraph | null; resultsVersion: string; known: string[] } = $props();
	const refs = $derived(new Set(known));
	const layout = $derived(graph ? relationshipLayout(graph) : null);
</script>

{#if anchors !== null}
	<section class="an-card" aria-labelledby="anchors-heading" id="analysis-anchors">
		<h2 id="anchors-heading">Evidence anchors</h2>
		<p>Documents and passages selected in the supplied analysis.</p>
		{#each anchors as a, i (i)}
			<article class="anchor" data-anchor={i}>
				<h3>{a.issue}</h3>
				<p><CitationLink {resultsVersion} ref={a.ref} page={a.page ?? null} exists={refs.has(a.ref)} />{#if a.title} · {a.title}{/if}{#if a.date} · {a.date}{/if}{#if a.rank !== undefined} · Rank {a.rank}{/if}</p>
				<p class="wrap">{a.why}</p>
				{#if a.quote}<blockquote>{a.quote}</blockquote>{/if}
			</article>
		{:else}<p class="an-empty">No evidence anchors were supplied.</p>{/each}
	</section>
{/if}

{#if layout}
	<section class="an-card" aria-labelledby="organogram-heading" id="analysis-organogram">
		<h2 id="organogram-heading">Organogram</h2>
		<p>{layout.nodes.length} nodes · {layout.edges.length} connections. Arrows follow the supplied source and destination; the lists below contain the full labels and references.</p>
		{#if layout.nodes.length}
			<div class="diagram">
				<svg viewBox="0 0 {layout.width} {layout.height}" role="img" aria-label="Organogram; full node and connection details follow">
					<defs><marker id="organogram-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
					{#each layout.edges as e, i (i)}{#if e.source && e.target}<line x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y} marker-end="url(#organogram-arrow)"><title>{e.source.label} → {e.target.label}: {e.label ?? e.type ?? ''}</title></line>{/if}{/each}
					{#each layout.nodes as n, i (i)}<g><rect x={n.x - 90} y={n.y - 25} width="180" height="50" rx="6" /><text x={n.x} y={n.y + 5} text-anchor="middle">{i + 1}. {n.label.length > 18 ? n.label.slice(0, 18) + '…' : n.label}</text><title>{n.label}</title></g>{/each}
				</svg>
			</div>
		{/if}
		<ol class="nodes">
			{#each layout.nodes as n, i (i)}<li data-node={i}><strong>{n.label}</strong> <span class="an-tag">({n.id})</span>{#if n.role} — {n.role}{/if}{#if n.kind} · {n.kind}{/if}{#if n.side} · {n.side}{/if}
				{#if n.ambiguous}<p>Duplicate node ID: connections to this ID need review.</p>{/if}
				{#each n.refs ?? [] as ref, j (j)}{' '}<CitationLink {resultsVersion} {ref} exists={refs.has(ref)} />{/each}
			</li>{/each}
		</ol>
		{#if layout.edges.length}
			<TableScroll label="Organogram connections" class="an-scroll"><table class="an-table an-stack" id="organogram-connections">
				<thead><tr><th>From</th><th>To</th><th>Relationship</th><th>Sources</th></tr></thead>
				<tbody>{#each layout.edges as e, i (i)}<tr data-edge={i}>
					<td data-label="From">{e.source?.label ?? e.from}{#if !e.source} (missing or duplicate node){/if}</td>
					<td data-label="To">{e.target?.label ?? e.to}{#if !e.target} (missing or duplicate node){/if}</td>
					<td data-label="Relationship">{e.label ?? e.type ?? 'Not supplied'}{#if e.label && e.type && e.label !== e.type} · {e.type}{/if}</td>
					<td data-label="Sources">{#each e.refs ?? [] as ref, j (j)}{' '}<CitationLink {resultsVersion} {ref} exists={refs.has(ref)} />{/each}</td>
				</tr>{/each}</tbody>
			</table></TableScroll>
		{:else}<p class="an-empty">No connections were supplied.</p>{/if}
	</section>
{/if}

<style>
	section { margin-top: 16px; }
	.anchor { padding: 12px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
	blockquote { white-space: pre-wrap; border-left: 3px solid var(--navy); padding-left: 12px; }
	.diagram { overflow-x: auto; }
	svg { width: 100%; min-width: 600px; display: block; }
	line { stroke: var(--ink-2); stroke-width: 2; }
	marker path { fill: var(--ink-2); }
	rect { fill: var(--paper, white); stroke: var(--navy); }
	text { fill: var(--ink); font-size: 12px; }
	.nodes li { margin: 12px 0; overflow-wrap: anywhere; }
</style>
