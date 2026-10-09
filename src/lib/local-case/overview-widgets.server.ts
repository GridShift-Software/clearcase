// Server registry of overview widget loaders, discovered from the owners' subtrees, and the slot states the overview
// renders. A loader that throws marks its slot as an error; it never breaks the overview.
import { collect, OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId, type SlotState, type WidgetContext } from '../components/overview-slots.ts';

const modules = import.meta.glob<Record<string, unknown>>('/src/lib/views/*/overview-widgets.server.ts', { eager: true });

export function loadersFrom(mods: Record<string, Record<string, unknown>>): ReadonlyMap<SlotId, OverviewWidgetLoader> {
	return collect<OverviewWidgetLoader>(mods, 'loaders');
}
const registered = loadersFrom(modules);

export async function slotStates(ctx: WidgetContext & { app: unknown }, loaders: ReadonlyMap<SlotId, OverviewWidgetLoader> = registered, filled: ReadonlySet<SlotId> = new Set(loaders.keys())): Promise<SlotState[]> {
	return Promise.all(OVERVIEW_SLOTS.map(async (slot): Promise<SlotState> => {
		const l = loaders.get(slot.id);
		if (!l || !filled.has(slot.id)) return { slot, status: 'unavailable' };
		try { return { slot, status: 'filled', data: await l.load(ctx) }; }
		catch (e) { console.error(`overview widget ${slot.id} failed:`, e); return { slot, status: 'error', message: 'This summary could not be loaded.' }; }
	}));
}
