// Types for modules.mjs.
export function moduleFiles(dir: string): string[];
export const IMPORTED: Map<string, Uint8Array>;
export function importModule(file: string): Promise<Record<string, unknown>>;
export function checkedModules(dirs: string[]): string[];
