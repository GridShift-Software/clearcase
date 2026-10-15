import type { OverviewWidget } from '../../components/overview-slots.ts';
import TileWidget from './TileWidget.svelte';

export const widgets: OverviewWidget<{ value: string; sub: string }>[] = [
	{ slot: 'deadlines', component: TileWidget },
	{ slot: 'unbilled-time', component: TileWidget },
];
