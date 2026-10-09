// Types for register.mjs.
import type { Entry } from './compare.mjs';
export const REPO: string;
export const REGISTER: string;
export const SCHEMA: string;
export function viewIds(): string[];
export function validateRegister(doc: unknown, opts?: { views?: string[]; owners?: Record<string, string> | null }): string[];
export function loadRegister(file?: string, opts?: { views?: string[]; owners?: Record<string, string> | null }): { entries: Entry[]; problems: string[] };
