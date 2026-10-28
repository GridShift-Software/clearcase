// The hosted overview's widget slots. The local loaders read the local case (src/lib/views/*/overview-widgets.server.ts);
// hosted fills a slot from what a page view already holds: freshness from the shard (the version pill carries the
// publication time). A slot whose owner has not ported it is left out rather than shown as "owned by GRS-nn" to a client:
// the deadlines and unbilled-time slots arrive with ticket 17a.
import { OVERVIEW_SLOTS, type SlotState } from '../../components/overview-slots.ts';
import { viewById, viewHref } from '../../components/views.ts';
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
