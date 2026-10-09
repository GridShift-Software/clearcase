// Client registry of overview widgets, discovered from the owners' subtrees (see overview-slots.ts).
import { collect, type OverviewWidget, type SlotId } from './overview-slots.ts';

const modules = import.meta.glob<Record<string, unknown>>('/src/lib/views/*/overview-widgets.ts', { eager: true });
export const widgets: ReadonlyMap<SlotId, OverviewWidget> = collect<OverviewWidget>(modules, 'widgets');
