// Types for outdir.mjs.
export function canonical(p: string): string;
export function fixtureInputs(fx: { caseFolder: string; cfg?: any; summaryPath?: string; packageDir?: string | null }, opts?: { appV5Html?: string }): [string, string][];
export function overlap(out: string, inputs: readonly (readonly [string, string])[]): string | null;
export function prepareOutput(out: string, inputs: readonly (readonly [string, string])[]): { views: string; work: string };
