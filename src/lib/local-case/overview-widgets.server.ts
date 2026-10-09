// Server registry of overview widget loaders, discovered from the owners' subtrees, and the slot states the overview
// renders. A loader that throws, or returns something the page data cannot carry (a function, a class instance, a
// symbol), marks its slot as an error; it never breaks the overview.
import { collect, OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId, type SlotState, type WidgetContext } from '../components/overview-slots.ts';

const modules = import.meta.glob<Record<string, unknown>>('/src/lib/views/*/overview-widgets.server.ts', { eager: true });

export function loadersFrom(mods: Record<string, Record<string, unknown>>): ReadonlyMap<SlotId, OverviewWidgetLoader> {
	return collect<OverviewWidgetLoader>(mods, 'loaders');
}
const registered = loadersFrom(modules);

/** Why a loader's value cannot travel as page data, or null. Plain data only: primitives (not symbols), arrays, plain
 *  objects, Date, Map and Set; a subset of what SvelteKit serializes, so an accepted value never fails the page. */
export function notPlainData(v: unknown, seen = new Set<object>()): string | null {
	if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return null;
	if (typeof v !== 'object') return `a ${typeof v}`;
	if (seen.has(v)) return null;
	seen.add(v);
	if (v instanceof Date) return null;
	const kids = Array.isArray(v) || v instanceof Set ? [...(v as Iterable<unknown>)] : v instanceof Map ? [...v].flat() : null;
	if (kids) return kids.reduce<string | null>((bad, x) => bad ?? notPlainData(x, seen), null);
	const proto = Object.getPrototypeOf(v);
	if (proto !== Object.prototype && proto !== null) return `an instance of ${String(proto?.constructor?.name || 'a class')}`;
	if (Object.getOwnPropertySymbols(v).length) return 'an object with symbol keys';
	for (const k of Object.keys(v)) { const bad = notPlainData((v as Record<string, unknown>)[k], seen); if (bad) return bad; }
	return null;
}

export async function slotStates(ctx: WidgetContext & { app: unknown }, loaders: ReadonlyMap<SlotId, OverviewWidgetLoader> = registered, filled: ReadonlySet<SlotId> = new Set(loaders.keys())): Promise<SlotState[]> {
	return Promise.all(OVERVIEW_SLOTS.map(async (slot): Promise<SlotState> => {
		const l = loaders.get(slot.id);
		if (!l || !filled.has(slot.id)) return { slot, status: 'unavailable' };
		try {
			const data = await l.load(ctx);
			const bad = notPlainData(data);
			if (bad) throw new Error(`the loader returned ${bad}, which is not plain data`);
			return { slot, status: 'filled', data };
		}
		catch (e) { console.error(`overview widget ${slot.id} failed:`, e); return { slot, status: 'error', message: 'This summary could not be loaded.' }; }
	}));
}
