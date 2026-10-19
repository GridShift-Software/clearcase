export const XLSX_SHA512: string;
export function unpinned(deps: Record<string, string>): [string, string][];
export function xlsxLockProblems(pj: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }, lock: string | null): string[];
