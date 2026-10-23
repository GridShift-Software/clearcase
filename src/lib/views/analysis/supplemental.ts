import type { Static } from 'typebox';
import type { AnalysisAnchor, Organogram } from '../../case-package/records.ts';

export type Anchor = Static<typeof AnalysisAnchor>;
export type RelationshipGraph = Static<typeof Organogram>;

type Point = { x: number; y: number };
type PositionedNode = RelationshipGraph['nodes'][number] & Point & { ambiguous: boolean };
type Obstacle = { left: number; right: number; top: number; bottom: number };
type RouteState = { point: number; direction: 'h' | 'v' | ''; cost: number; previous: string | null };

const routeClear = (a: Point, b: Point, obstacles: Obstacle[]) => obstacles.every((r) => {
	if (a.y === b.y) return !(a.y > r.top && a.y < r.bottom && Math.max(Math.min(a.x, b.x), r.left) < Math.min(Math.max(a.x, b.x), r.right));
	if (a.x === b.x) return !(a.x > r.left && a.x < r.right && Math.max(Math.min(a.y, b.y), r.top) < Math.min(Math.max(a.y, b.y), r.bottom));
	return false;
});

function routeBetween(start: Point, end: Point, blockers: PositionedNode[]): Point[] | null {
	const obstacles = blockers.map((n) => ({ left: n.x - 94, right: n.x + 94, top: n.y - 29, bottom: n.y + 29 }));
	const xs = new Set([start.x, end.x]), ys = new Set([start.y, end.y]);
	for (const r of obstacles) {
		xs.add(r.left); xs.add(r.right); ys.add(r.top); ys.add(r.bottom);
	}
	if (obstacles.length) {
		xs.add(Math.min(...obstacles.map((r) => r.left)) - 10);
		xs.add(Math.max(...obstacles.map((r) => r.right)) + 10);
		ys.add(Math.min(...obstacles.map((r) => r.top)) - 10);
		ys.add(Math.max(...obstacles.map((r) => r.bottom)) + 10);
	}
	const columns = [...xs].sort((a, b) => a - b), rows = [...ys].sort((a, b) => a - b);
	const points: Point[] = [], byCoordinate = new Map<string, number>();
	for (const y of rows) for (const x of columns) {
		const p = { x, y };
		if (obstacles.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom)) continue;
		byCoordinate.set(`${x},${y}`, points.push(p) - 1);
	}
	const startIndex = byCoordinate.get(`${start.x},${start.y}`), endIndex = byCoordinate.get(`${end.x},${end.y}`);
	if (startIndex === undefined || endIndex === undefined) return null;
	const neighbors: number[][] = points.map(() => []);
	for (const y of rows) {
		const row = columns.map((x) => byCoordinate.get(`${x},${y}`)).filter((i): i is number => i !== undefined);
		for (let i = 1; i < row.length; i++) {
			const a = row[i - 1]!, b = row[i]!;
			if (routeClear(points[a]!, points[b]!, obstacles)) { neighbors[a]!.push(b); neighbors[b]!.push(a); }
		}
	}
	for (const x of columns) {
		const column = rows.map((y) => byCoordinate.get(`${x},${y}`)).filter((i): i is number => i !== undefined);
		for (let i = 1; i < column.length; i++) {
			const a = column[i - 1]!, b = column[i]!;
			if (routeClear(points[a]!, points[b]!, obstacles)) { neighbors[a]!.push(b); neighbors[b]!.push(a); }
		}
	}
	const stateKey = (point: number, direction: string) => `${point}:${direction}`;
	const startKey = stateKey(startIndex, '');
	const states = new Map<string, RouteState>([[startKey, { point: startIndex, direction: '', cost: 0, previous: null }]]);
	const pending = [startKey], settled = new Set<string>();
	let found: string | null = null;
	while (pending.length) {
		pending.sort((a, b) => states.get(b)!.cost - states.get(a)!.cost);
		const key = pending.pop()!;
		if (settled.has(key)) continue;
		settled.add(key);
		const current = states.get(key)!;
		if (current.point === endIndex) { found = key; break; }
		for (const next of neighbors[current.point]!) {
			const a = points[current.point]!, b = points[next]!;
			const direction = a.y === b.y ? 'h' : 'v';
			const nextKey = stateKey(next, direction);
			const cost = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (current.direction && current.direction !== direction ? 40 : 0);
			if (cost >= (states.get(nextKey)?.cost ?? Infinity)) continue;
			states.set(nextKey, { point: next, direction, cost, previous: key });
			pending.push(nextKey);
		}
	}
	if (!found) return null;
	const route: Point[] = [];
	for (let key: string | null = found; key; key = states.get(key)!.previous) route.push(points[states.get(key)!.point]!);
	return route.reverse();
}

function routeEdge(source: PositionedNode, target: PositionedNode, nodes: PositionedNode[]) {
	const dx = target.x - source.x, dy = target.y - source.y;
	if (!dx && !dy) return `M ${source.x + 60} ${source.y - 25} C ${source.x + 130} ${source.y - 65}, ${source.x - 130} ${source.y - 65}, ${source.x - 60} ${source.y - 25}`;
	const sourceAnchors = [{ x: source.x + 90, y: source.y }, { x: source.x - 90, y: source.y }, { x: source.x, y: source.y + 25 }, { x: source.x, y: source.y - 25 }];
	const targetAnchors = [{ x: target.x - 90, y: target.y }, { x: target.x + 90, y: target.y }, { x: target.x, y: target.y - 25 }, { x: target.x, y: target.y + 25 }];
	const blockers = nodes.filter((n) => n !== source && n !== target);
	let best: { points: Point[]; score: number } | null = null;
	for (const from of sourceAnchors) for (const to of targetAnchors) {
		const points = routeBetween(from, to, blockers);
		if (!points) continue;
		const length = points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);
		const alignment = (from.x - source.x) * dx + (from.y - source.y) * dy + (target.x - to.x) * dx + (target.y - to.y) * dy;
		const score = length - alignment * 0.01;
		if (!best || score < best.score) best = { points, score };
	}
	return best ? best.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') : '';
}

/** Layout is presentation only. Ambiguous or missing endpoints remain in the connection list. */
export function relationshipLayout(graph: RelationshipGraph) {
	const counts = new Map<string, number>();
	for (const n of graph.nodes) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
	const nodes = graph.nodes.map((n, i) => ({ ...n, x: 120 + (i % 3) * 240, y: 55 + Math.floor(i / 3) * 110, ambiguous: counts.get(n.id)! > 1 }));
	const byId = new Map(nodes.filter((n) => !n.ambiguous).map((n) => [n.id, n]));
	const edges = graph.edges.map((e) => {
		const source = byId.get(e.from) ?? null, target = byId.get(e.to) ?? null;
		const path = source && target ? routeEdge(source, target, nodes) : '';
		return { ...e, source, target, path };
	});
	return { nodes, edges, width: 720, height: Math.max(110, Math.ceil(nodes.length / 3) * 110) };
}
