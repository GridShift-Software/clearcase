// The overview's widget slots (an M2 extension point). The slots are declared here (coordinator-owned); an owner fills
// one from its own subtree, never by editing the overview:
//   src/lib/views/<category>/overview-widgets.ts         export const widgets: OverviewWidget[]        (component)
//   src/lib/views/<category>/overview-widgets.server.ts  export const loaders: OverviewWidgetLoader[]  (server data)
// Both are discovered by import.meta.glob. <category> must be the slot owner's route category, so an owner can only
// fill its own slots; a slot filled twice, an unknown slot or a foreign category is an error at load. An unfilled
// slot renders "not yet available — owned by GRS-nn". Browser-safe.
import type { Component } from 'svelte';
import type { ViewCategory } from './view-registry.ts';

export const OVERVIEW_SLOTS = Object.freeze([
	{ id: 'deadlines', title: 'Open deadlines', owner: 'CC-07', linear: 'GRS-17', category: 'registers' },
	{ id: 'unbilled-time', title: 'Unbilled time', owner: 'CC-07', linear: 'GRS-17', category: 'registers' },
	{ id: 'rescan-freshness', title: 'Freshness', owner: 'CC-10', linear: 'GRS-20', category: 'system' },
] as const satisfies readonly { id: string; title: string; owner: string; linear: string; category: ViewCategory }[]);

export type SlotId = (typeof OVERVIEW_SLOTS)[number]['id'];
export type SlotDef = (typeof OVERVIEW_SLOTS)[number];
/** What every widget receives besides its own data. */
export interface WidgetContext { caseId: string; caseName: string; resultsVersion: string }
export interface OverviewWidget<D = unknown> { slot: SlotId; component: Component<{ data: D; ctx: WidgetContext }> }
/** Server side of a widget: data for one version of one case (user work, results). Runs in the overview's load. */
export interface OverviewWidgetLoader<D = unknown, A = unknown> { slot: SlotId; load(ctx: WidgetContext & { app: A }): D | Promise<D> }

/** The slot state the overview renders. */
export type SlotState = { slot: SlotDef; status: 'filled'; data: unknown } | { slot: SlotDef; status: 'unavailable' } | { slot: SlotDef; status: 'error'; message: string };

const CATEGORY_OF = /\/src\/lib\/views\/([a-z]+)\/overview-widgets(?:\.server)?\.ts$/;

/** Validate glob-discovered modules and index their entries by slot (shared by the client and server registries). */
export function collect<E extends { slot: string }>(modules: Record<string, Record<string, unknown>>, exportName: 'widgets' | 'loaders'): Map<SlotId, E> {
	const out = new Map<SlotId, E>();
	for (const [file, mod] of Object.entries(modules)) {
		const category = CATEGORY_OF.exec(file)?.[1];
		const entries = mod[exportName];
		if (!category || !Array.isArray(entries)) throw new Error(`${file}: expected export ${exportName} under src/lib/views/<category>/`);
		for (const e of entries as E[]) {
			const slot = OVERVIEW_SLOTS.find((s) => s.id === e.slot);
			if (!slot) throw new Error(`${file}: unknown overview slot ${String(e.slot)}`);
			if (slot.category !== category) throw new Error(`${file}: slot ${slot.id} belongs to ${slot.linear} (${slot.category}), not ${category}`);
			if (out.has(slot.id)) throw new Error(`${file}: slot ${slot.id} is filled twice`);
			out.set(slot.id, e);
		}
	}
	return out;
}
