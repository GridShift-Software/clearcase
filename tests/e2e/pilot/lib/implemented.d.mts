// Types for implemented.mjs.
export interface RegistryView { id: string; label: string; owner: string; linear: string; category: string | null; route: string; status: string }
export interface SlotDecl { id: string; title: string; owner: string; linear: string; category: string }
export interface Destination { h1: string | null; ready: string | null; unavailable: string | null; owner: string | null; text: string | null; current: string | null }
export interface ObservedSlot { id: string; status: string; heading: string | null; text: string | null }
export function registryOf(root: string): Promise<{ views: RegistryView[]; slots: SlotDecl[] }>;
export function routeFile(root: string, v: RegistryView): string | null;
export function implementedViews(root: string, views: readonly RegistryView[]): Set<string>;
export function filledSlots(root: string, slots: readonly SlotDecl[]): Set<string>;
export function firstUnimplemented(views: readonly RegistryView[], implemented: ReadonlySet<string>): RegistryView | null;
export function readyKind(v: RegistryView, implemented: ReadonlySet<string>): string;
export function destinationOk(v: RegistryView, s: Destination, opts: { owner: string | null; implemented: ReadonlySet<string>; navStatus: string | undefined }): boolean;
export function expectedSlot(s: SlotDecl, filled: ReadonlySet<string>): { id: string; status: string; heading: string; text?: string };
export function observedSlot(o: ObservedSlot, filled: ReadonlySet<string>): { id: string; status: string; heading: string | null; text?: string | null };
export function modeSummary(views: readonly RegistryView[], implemented: ReadonlySet<string>, filled: ReadonlySet<string>): { implemented: string[]; filledSlots: string[]; example: string };
export function slotsFromHtml(html: string, decode?: (s: string) => string): ObservedSlot[];
