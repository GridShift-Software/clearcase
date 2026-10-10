// The parity modules the runner finds by listing a folder rather than by an import in committed code: the app adapters
// (adapters/app/*.mjs), the v5 view specs (adapters/v5/specs/*.mjs) and the overview slot plug-ins
// (adapters/app/slots/*.mjs). The three loaders share this one listing rule, so the runner checks exactly the files
// they import: each must be a committed review input, or the run is not evidence (lib/register.mjs runNonEvidence).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The `*.mjs` files in `dir` whose names do not start with `_` (helpers), in file-name order; none when `dir` is missing. */
export const moduleFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('_')).sort().map((n) => join(dir, n)) : []);
