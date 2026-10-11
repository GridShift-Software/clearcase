// The overview's Freshness slot, client side (GRS-20).
import type { OverviewWidget } from '$lib/components/overview-slots';
import FreshnessWidget from './FreshnessWidget.svelte';
import type { FreshnessData } from './freshness';

export const widgets: OverviewWidget<FreshnessData>[] = [{ slot: 'rescan-freshness', component: FreshnessWidget }];
