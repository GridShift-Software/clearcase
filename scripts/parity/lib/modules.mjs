// The parity modules the runner finds by listing a folder rather than by an import in committed code: the app adapters
// (adapters/app/*.mjs), the v5 view specs (adapters/v5/specs/*.mjs) and the overview slot plug-ins
// (adapters/app/slots/*.mjs). The three loaders share this one listing rule and importModule, so the runner checks
// the files they list and the files they imported (checkedModules), against the bytes they imported: each must be a
// committed review input, or the run is not evidence (lib/register.mjs runNonEvidence).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `*.mjs` files in `dir` whose names do not start with `_` (helpers), in file-name order; none when `dir` is missing. */
export const moduleFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('_')).sort().map((n) => join(dir, n)) : []);

/**
 * The bytes of each module importModule imported in this process, by path, read just before its first import (the
 * module cache keeps that module).
 */
export const IMPORTED = new Map();

/** Import a listed module, keeping the bytes it had just before its first import (IMPORTED). */
export async function importModule(file) {
	if (!IMPORTED.has(file)) IMPORTED.set(file, readFileSync(file));
	return import(file);
}

/**
 * The modules a run must check: those the loaders list in `dirs` now, and every one importModule imported, so a module
 * that deleted or renamed itself once imported is still checked (the listing alone would no longer show it).
 */
export const checkedModules = (dirs) => [...new Set([...dirs.flatMap(moduleFiles), ...IMPORTED.keys()])];
