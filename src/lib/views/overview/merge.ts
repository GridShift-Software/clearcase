import type { SlotState } from '../../components/overview-slots.ts';
import type { NoteSummary } from '../../server/runtime/dto.ts';
import type { OverviewShard } from './pure.server.ts';

/** What the overview adds to its shard: the notes summary, the version it replaced, and the filled slots. */
export interface OverviewWork {
	notes: NoteSummary;
	previous: string | null;
	slots: SlotState[];
}

export const overviewMerge = (shard: OverviewShard, work: OverviewWork) => ({ ...shard, notes: work.notes, previous: work.previous, slots: work.slots });
