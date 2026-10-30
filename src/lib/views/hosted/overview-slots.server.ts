// The hosted overview's widget slots. The local loaders read the local case (src/lib/views/*/overview-widgets.server.ts);
// hosted fills a slot from what a page view already holds: freshness from the shard (the version pill carries the
// publication time). The deadlines and unbilled-time slots come from the registers (ticket 17a), one `readViewWork` each. A
// slot whose owner has not ported it is left out rather than shown as "owned by GRS-nn" to a client.
import { OVERVIEW_SLOTS, type SlotState } from '../../components/overview-slots.ts';
import { viewById, viewHref } from '../../components/views.ts';
import type { CaseId, RequestServices } from '../../server/runtime/contracts.ts';
import { REGISTERS } from '../registers/defs.ts';
import { hostedRows } from '../registers/hosted.server.ts';
import { openDeadlines, unbilledTime } from '../registers/logic.ts';
import type { FreshnessData } from '../system/freshness.ts';

const slot = (id: SlotState['slot']['id']) => OVERVIEW_SLOTS.find((s) => s.id === id)!;

export function hostedOverviewSlots(a: { resultsVersion: string; base: string; builtAt: string; documents: number }): SlotState[] {
  const freshness: FreshnessData = {
    builtAt: a.builtAt,
    documents: a.documents,
    viaRescan: 0,
    lastScan: null,
    href: viewHref(a.resultsVersion, viewById('overview')!, a.base),
  };
  return [{ slot: slot('rescan-freshness'), status: 'filled', data: freshness }];
}

const registerRows = async (locals: Pick<RequestServices, 'userWork'>, caseId: CaseId, view: 'deadlines_tab' | 'timesheet_tab') => {
  const def = REGISTERS[view];
  return hostedRows(def, (await locals.userWork.readViewWork({ caseId, store: def.store })).rows);
};

/**
 * The deadlines and unbilled-time tiles, from the case's registers: one read each, together. A register that cannot be read
 * leaves its own tile in an error state; the overview still renders.
 */
export async function hostedRegisterSlots(locals: Pick<RequestServices, 'userWork' | 'runtime'>, a: { caseId: CaseId }): Promise<SlotState[]> {
  const [deadlines, timesheet] = await Promise.allSettled([registerRows(locals, a.caseId, 'deadlines_tab'), registerRows(locals, a.caseId, 'timesheet_tab')]);
  const failed = (id: SlotState['slot']['id']): SlotState => ({ slot: slot(id), status: 'error', message: 'This tile could not be read right now. Reload the page to try again.' });
  return [
    deadlines.status === 'fulfilled'
      ? { slot: slot('deadlines'), status: 'filled', data: { value: String(openDeadlines(deadlines.value, locals.runtime.now())), sub: 'in the deadline tracker' } }
      : failed('deadlines'),
    timesheet.status === 'fulfilled'
      ? { slot: slot('unbilled-time'), status: 'filled', data: unbilledTile(timesheet.value) }
      : failed('unbilled-time'),
  ];
}

function unbilledTile(rows: Parameters<typeof unbilledTime>[0]) {
  const t = unbilledTime(rows);
  return { value: t.value, sub: t.uncounted ? `recorded, not yet billed; ${t.uncounted} ${t.uncounted === 1 ? 'entry' : 'entries'} not counted (hours not a number)` : 'recorded, not yet billed' };
}
