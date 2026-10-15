
export type OpAction = 'select' | 'co' | 'mode';
export interface Op {
	id: number;
	action: OpAction;
	value: string;
	keys: string[];
	error?: string;
}

export const CHUNK_BYTES = 256 * 1024;
const PART_OVERHEAD = 160;
const te = new TextEncoder();
export function chunkKeys(keys: readonly string[], limit = CHUNK_BYTES, perKey = PART_OVERHEAD): string[][] {
	const out: string[][] = [];
	let cur: string[] = [], size = 0;
	for (const k of keys) {
		const n = te.encode(k).length * 2 + perKey;
		if (cur.length && size + n > limit) { out.push(cur); cur = []; size = 0; }
		cur.push(k);
		size += n;
	}
	if (cur.length || !out.length) out.push(cur);
	return out;
}

const sameField = (a: Op, b: Op) => a.action === b.action;

export function supersede(earlier: readonly Op[], later: Op): Op[] {
	if (later.action === 'mode') return earlier.filter((o) => o.action !== 'mode');
	const ks = new Set(later.keys);
	return earlier.map((o) => (sameField(o, later) ? { ...o, keys: o.keys.filter((k) => !ks.has(k)) } : o)).filter((o) => o.action === 'mode' || o.keys.length > 0);
}

export function stillOwed(op: Op, laterQueued: readonly Op[]): Op | null {
	const [rest] = laterQueued.reduce((acc, l) => supersede(acc, l), [op] as Op[]);
	return rest ?? null;
}
