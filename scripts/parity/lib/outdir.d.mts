// Types for outdir.mjs.
type Inputs = readonly (readonly [string, string])[];
export function canonical(p: string): string;
export function locatorInputs(cfg: any, opts?: { appV5Html?: string; repo?: string }): [string, string][];
export function fixtureInputs(fx: { caseFolder: string; cfg?: any; summaryPath?: string; packageDir?: string | null }, opts?: { appV5Html?: string }): [string, string][];
export function overlap(out: string, inputs: Inputs): string | null;
export function checkOutput(out: string, inputs: Inputs, children?: readonly string[]): (...parts: string[]) => string;
export function sweepStaleWork(out: string, at: (...parts: string[]) => string): string[];
export function prepareOutput(out: string, inputs: Inputs, children?: readonly string[]): { at: (...parts: string[]) => string; views: string; work: string; swept: string[] };
export const SIGNALS: { SIGHUP: number; SIGINT: number; SIGTERM: number };
export function removeOnExit(dir: string): void;
