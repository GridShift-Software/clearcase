import type { InfoRow } from '../../analysis/info-required.server.ts';
import type { RegisterRow } from '../../server/runtime/dto.ts';

/** The Information Required shard (ticket 04): the heading and every item, unchecked. */
export interface InfoRequiredShard {
	heading: string;
	rows: InfoRow[];
}

/** The page data from the shard and the saved checks (`info-required` rows keyed by item key); `detached` counts ticked checks of items no longer listed. */
export function infoRequiredMerge(shard: InfoRequiredShard, work: { rows: readonly Pick<RegisterRow, 'rowId' | 'fields'>[] }) {
	const saved = new Map(work.rows.map((r) => [r.rowId, r.fields.done === true]));
	const here = new Set(shard.rows.map((r) => r.key));
	return {
		heading: shard.heading,
		rows: shard.rows.map((r) => ({ ...r, done: saved.get(r.key) ?? false })),
		detached: [...saved].filter(([k, done]) => done && !here.has(k)).length,
	};
}
