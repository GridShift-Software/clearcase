// The Discovery Schedule's write operations (GRS-19): a tick, a Copy/Original mark, Clear and the schedule mode, sent
// one at a time in order. A failed op keeps its own error and Retry and never blocks later ops. Ordering rule: an op
// that sets the same field of the same file as an earlier failed op removes that file from the failed op, so a Retry
// never writes an older value over a newer one. A large selection is sent in chunks bounded by bytes. Pure.

export type OpAction = 'select' | 'co' | 'mode';
export interface Op {
	id: number;
	action: OpAction;
	/** '1' or '0' for select, 'C' or 'O' for co, the mode for mode */
	value: string;
	/** the files it sets (none for mode) */
	keys: string[];
	error?: string;
}

/** The server's default body limit is 512 KB; a chunk stays under half of it, multipart overhead included. */
export const CHUNK_BYTES = 256 * 1024;
const PART_OVERHEAD = 160;
const te = new TextEncoder();
/** Split keys into chunks whose multipart body stays under `limit` bytes (each chunk holds at least one key). */
export function chunkKeys(keys: readonly string[], limit = CHUNK_BYTES, perKey = PART_OVERHEAD): string[][] {
	const out: string[][] = [];
	let cur: string[] = [], size = 0;
	for (const k of keys) {
		const n = te.encode(k).length * 2 + perKey; // the key, its base mark and their part headers
		if (cur.length && size + n > limit) { out.push(cur); cur = []; size = 0; }
		cur.push(k);
		size += n;
	}
	if (cur.length || !out.length) out.push(cur);
	return out;
}

/** Whether `later` sets a field `earlier` also sets (same action, so the same column, or both the mode). */
const sameField = (a: Op, b: Op) => a.action === b.action;

/** Earlier ops with the files `later` sets removed from them (an emptied op is dropped; a mode op replaces the mode). */
export function supersede(earlier: readonly Op[], later: Op): Op[] {
	if (later.action === 'mode') return earlier.filter((o) => o.action !== 'mode');
	const ks = new Set(later.keys);
	return earlier.map((o) => (sameField(o, later) ? { ...o, keys: o.keys.filter((k) => !ks.has(k)) } : o)).filter((o) => o.action === 'mode' || o.keys.length > 0);
}

/** A failed op's files that no later queued op sets again (those later ops carry the newer value). */
export function stillOwed(op: Op, laterQueued: readonly Op[]): Op | null {
	const [rest] = laterQueued.reduce((acc, l) => supersede(acc, l), [op] as Op[]);
	return rest ?? null;
}
