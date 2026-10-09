// Types for specs.mjs.
export type Sweep = { id: string; v5: (p: any, ctx: any) => Promise<Record<string, string>>; [k: string]: unknown };
export type Spec = { key?: string; postRaw?: (raw: any) => void; storage?: Record<string, string>; sweeps?: Sweep[] };
export const SPECS: Record<string, Spec>;
export const SPEC_DIR: string;
export const registerSweep: Sweep;
export function loadSpecs(dir?: string, opts?: { views?: string[] }): Promise<Record<string, Spec>>;
