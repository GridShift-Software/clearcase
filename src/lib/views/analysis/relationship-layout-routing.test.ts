import { describe, expect, it } from 'vitest';
import { relationshipLayout } from './supplemental';

const node = (id: string) => ({ id, label: id });
const points = (path: string) => {
	const commands = [...path.matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
	return commands.map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
};
const crossesBox = (a: { x: number; y: number }, b: { x: number; y: number }, box: { x: number; y: number }) => {
	const left = box.x - 90, right = box.x + 90, top = box.y - 25, bottom = box.y + 25;
	let enter = 0, exit = 1;
	for (const [start, delta, low, high] of [[a.x, b.x - a.x, left, right], [a.y, b.y - a.y, top, bottom]]) {
		if (!delta) {
			if (start <= low || start >= high) return false;
			continue;
		}
		const first = (low - start) / delta, last = (high - start) / delta;
		enter = Math.max(enter, Math.min(first, last));
		exit = Math.min(exit, Math.max(first, last));
		if (enter >= exit) return false;
	}
	const middle = (enter + exit) / 2;
	const x = a.x + (b.x - a.x) * middle, y = a.y + (b.y - a.y) * middle;
	return x > left && x < right && y > top && y < bottom;
};

function expectNoUnrelatedNodeCrossing(nodeCount: number, fromIndex: number, toIndex: number) {
	const nodes = Array.from({ length: nodeCount }, (_, i) => node(String(i)));
	const layout = relationshipLayout({ nodes, edges: [{ from: String(fromIndex), to: String(toIndex) }] });
	const edge = layout.edges[0]!;
	const route = points(edge.path);
	expect(route.length).toBeGreaterThanOrEqual(2);
	for (let i = 1; i < route.length; i++) {
		for (const box of layout.nodes) {
			if (box.id === edge.from || box.id === edge.to) continue;
			expect(crossesBox(route[i - 1]!, route[i]!, box), `${edge.from} → ${edge.to} crosses unrelated node ${box.id}`).toBe(false);
		}
	}
}

describe('relationship edge routing', () => {
	it('routes same-row nonadjacent nodes around intervening boxes', () => expectNoUnrelatedNodeCrossing(3, 0, 2));
	it('routes same-column nonadjacent nodes around intervening boxes', () => expectNoUnrelatedNodeCrossing(7, 0, 6));
	it('routes diagonal nonadjacent nodes around intervening boxes', () => expectNoUnrelatedNodeCrossing(9, 0, 8));
});
