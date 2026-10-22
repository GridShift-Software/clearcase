import type { Static } from 'typebox';
import type { AnalysisAnchor, Organogram } from '../../case-package/records.ts';

export type Anchor = Static<typeof AnalysisAnchor>;
export type RelationshipGraph = Static<typeof Organogram>;

/** Layout is presentation only. Ambiguous or missing endpoints remain in the connection list. */
export function relationshipLayout(graph: RelationshipGraph) {
	const counts = new Map<string, number>();
	for (const n of graph.nodes) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
	const nodes = graph.nodes.map((n, i) => ({ ...n, x: 120 + (i % 3) * 240, y: 55 + Math.floor(i / 3) * 110, ambiguous: counts.get(n.id)! > 1 }));
	const byId = new Map(nodes.filter((n) => !n.ambiguous).map((n) => [n.id, n]));
	const edges = graph.edges.map((e) => {
		const source = byId.get(e.from) ?? null, target = byId.get(e.to) ?? null;
		let path = '';
		if (source && target) {
			const dx = target.x - source.x, dy = target.y - source.y;
			if (!dx && !dy) path = `M ${source.x + 60} ${source.y - 25} C ${source.x + 130} ${source.y - 65}, ${source.x - 130} ${source.y - 65}, ${source.x - 60} ${source.y - 25}`;
			else {
				const trim = Math.min(dx ? 90 / Math.abs(dx) : Infinity, dy ? 25 / Math.abs(dy) : Infinity);
				path = `M ${source.x + dx * trim} ${source.y + dy * trim} L ${target.x - dx * trim} ${target.y - dy * trim}`;
			}
		}
		return { ...e, source, target, path };
	});
	return { nodes, edges, width: 720, height: Math.max(110, Math.ceil(nodes.length / 3) * 110) };
}
