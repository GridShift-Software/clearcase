// Types for _shell.mjs (the parts tests and adapters written in TypeScript use).
export interface SlotPlugin {
	read(p: unknown, ctx: unknown): Promise<{ value: string; sub: string }> | { value: string; sub: string };
	seed(p: unknown, ctx: unknown, rows: unknown): Promise<void> | void;
	cleanup(p: unknown, ctx: unknown): Promise<void> | void;
}
export const ready: (view: string) => string;
export function open(p: unknown, ctx: unknown, route: string, view: string): Promise<void>;
export const TILE_LABEL: Readonly<Record<string, string>>;
export const SLOTS_DIR: string;
export function loadSlotPlugins(dir?: string, root?: string): Promise<Map<string, SlotPlugin>>;
export function slotPlugins(ctx: { slotPlugins?: Map<string, SlotPlugin>; appRoot?: string }): Promise<Map<string, SlotPlugin>>;
export function assertOverview(p: unknown, who: string): Promise<void>;
export function readOverviewSnapshot(p: unknown, ctx: unknown): Promise<any>;
export function readOverviewTiles(p: unknown, ctx: unknown): Promise<Record<string, { value: string; sub: string }>>;
