import { collect, OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId, type SlotState, type WidgetContext } from '../components/overview-slots.ts';

const modules = import.meta.glob<Record<string, unknown>>('/src/lib/views/*/overview-widgets.server.ts', { eager: true });

export function loadersFrom(mods: Record<string, Record<string, unknown>>): ReadonlyMap<SlotId, OverviewWidgetLoader> {
	return collect<OverviewWidgetLoader>(mods, 'loaders');
}
const registered = loadersFrom(modules);

/** How long the overview waits for one slot loader before showing that slot's error state. It bounds waiting on a
 *  pending promise only: a loader that computes synchronously (node:sqlite reads are synchronous) blocks the server
 *  until it returns, so loaders must stay within the overview budget themselves. */
export const SLOT_LOADER_TIMEOUT_MS = 5_000;
/** How deeply slot data may nest (devalue, SvelteKit's serializer, recurses and overflows the stack far deeper). */
export const MAX_SLOT_DATA_DEPTH = 100;
/** Own keys devalue refuses (`__proto__`) or that could reach a prototype when the data is merged client-side. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function notPlainData(v: unknown, seen = new Set<object>(), depth = 0): string | null {
	if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return null;
	if (typeof v !== 'object') return `a ${typeof v}`;
	if (seen.has(v)) return null;
	if (depth > MAX_SLOT_DATA_DEPTH) return `data nested deeper than ${MAX_SLOT_DATA_DEPTH} levels`;
	seen.add(v);
	if (typeof (v as { then?: unknown }).then === 'function') return 'a thenable';
	if (v instanceof Date) return null;
	const kids = Array.isArray(v) || v instanceof Set ? [...(v as Iterable<unknown>)] : v instanceof Map ? [...v].flat() : null;
	if (kids) return kids.reduce<string | null>((bad, x) => bad ?? notPlainData(x, seen, depth + 1), null);
	const proto = Object.getPrototypeOf(v);
	if (proto !== Object.prototype && proto !== null) return `an instance of ${String(proto?.constructor?.name || 'a class')}`;
	if (Object.getOwnPropertySymbols(v).length) return 'an object with symbol keys';
	for (const k of Object.keys(v)) {
		if (RESERVED_KEYS.has(k)) return `an object with an own ${k} key`;
		const bad = notPlainData((v as Record<string, unknown>)[k], seen, depth + 1);
		if (bad) return bad;
	}
	return null;
}

async function within<T>(p: Promise<T> | T, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the loader did not settle within ${ms} ms`)), ms); })]);
	} finally { clearTimeout(timer); }
}

export async function slotStates(ctx: WidgetContext & { app: unknown }, loaders: ReadonlyMap<SlotId, OverviewWidgetLoader> = registered, filled: ReadonlySet<SlotId> = new Set(loaders.keys()), timeoutMs = SLOT_LOADER_TIMEOUT_MS): Promise<SlotState[]> {
	return Promise.all(OVERVIEW_SLOTS.map(async (slot): Promise<SlotState> => {
		const l = loaders.get(slot.id);
		if (!l || !filled.has(slot.id)) return { slot, status: 'unavailable' };
		try {
			const data = await within(l.load(ctx), timeoutMs);
			const bad = notPlainData(data);
			if (bad) throw new Error(`the loader returned ${bad}, which is not plain data`);
			return { slot, status: 'filled', data };
		}
		catch (e) { console.error(`overview widget ${slot.id} failed:`, e); return { slot, status: 'error', message: 'This summary could not be loaded.' }; }
	}));
}
