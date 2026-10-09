// Types for normalize.mjs.
export function ws(s: unknown): string;
export function number(s: unknown): string;
export function date(s: unknown): string;
export function value(s: unknown): string;
export function canonicalTies(keys: readonly string[], sortValues: readonly string[]): string[];
export function controlId(kind: string, label: string): string;
export function inventory(controls: readonly { kind: string; label: string }[]): Record<string, number>;
export function slug(s: unknown): string;
