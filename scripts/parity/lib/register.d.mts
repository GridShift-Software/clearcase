// Types for register.mjs.
import type { Entry } from './compare.mjs';
export const REPO: string;
export const REGISTER: string;
export const SCHEMA: string;
export function viewIds(): string[];
export function registryOwners(root?: string): Promise<Record<string, string>>;
export function identityKey(s: string): string;
export const RANGES: Readonly<Record<string, [number, number]>>;
export const LEGACY: Readonly<Record<string, string[]>>;
export function registryKeys(root?: string): Promise<Record<string, string>>;
type Opts = { views?: string[]; owners?: Record<string, string> | null; keys?: Record<string, string> | null };
export function validateRegister(doc: unknown, opts?: Opts & { fragment?: string | null; ids?: Set<unknown> }): string[];
export function loadRegister(file?: string, opts?: Opts): { entries: Entry[]; problems: string[]; files: Record<string, string> };
export function unusedEntries(entries: Entry[], ran: string[], used: Set<string>): string[];
