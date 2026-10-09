// Types for sweeps.mjs.
export const FNV_SRC: string;
export function fnv(s: string): string;
export function seqValue(keys: readonly string[]): string;
export const SORTS: readonly ['date', 'ref', 'docType', 'bundle', 'amount'];
export const QUERIES: readonly string[];
export const STATUSES: readonly string[];
export interface Dims { bundles: string[]; types: string[]; statuses: string[]; queries: readonly string[]; sorts: readonly string[] }
export interface Combo { key: string; b: number; t: number; s: number; q: number; k: number; d: 1 | -1 }
export function chronologyDims(rows: readonly Record<string, unknown>[]): Dims;
export function uiCombos(dims: Dims): Combo[];
export function engineCombos(dims: Dims): Combo[];
export function seededUserWork(clock: string): { ess_dcs_deadlines_v1: { title: string; date: string; cat: string; note: string }[]; ess_dcs_timesheet_v1: { date: string; fee_earner: string; activity: string; hours: string; rate: string; billed: string }[] };
export function syntheticInput(type: string, n: number, clock: string): string;
