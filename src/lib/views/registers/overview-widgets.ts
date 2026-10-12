// The registers' overview widgets (GRS-17): the Open deadlines and Unbilled time tiles, filled from the deadline and
// timesheet registers (data from overview-widgets.server.ts).
import type { OverviewWidget } from '../../components/overview-slots.ts';
import TileWidget from './TileWidget.svelte';

export const widgets: OverviewWidget<{ value: string; sub: string }>[] = [
	{ slot: 'deadlines', component: TileWidget },
	{ slot: 'unbilled-time', component: TileWidget },
];
